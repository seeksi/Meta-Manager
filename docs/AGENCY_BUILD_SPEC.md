# Build Spec / Pre-Prompt — "Ads by Rex" Meta Ads Management Engine

> Hand-off brief for the planning committee + dev team. Goal: take Meta-ads **management**
> (the retainer service) from "working single-brand desktop app + audit pipeline" to
> **fully built, wired into the sales pipeline, and production-ready for a small agency**.

---

## 0. Objective & locked decisions

**Objective.** Stand up an always-on engine that lets one operator safely manage *multiple
client* Meta ad accounts — ingesting metrics, proposing optimizations, and executing
guardrailed changes — fed directly by approved fixes from the audit→proposal pipeline.

**Decisions already made (do not re-litigate):**
- **Scale = solo / small-agency engine (Path A).** EXTEND the existing `ADS/Meta-Manager/`
  app to be multi-client. Do **not** build the multi-tenant SaaS from the
  `meta-ads-automation/` blueprint, and do **not** rebuild the guardrail/executor logic —
  it is production-grade and reused as-is. (Aligns with the standing "PAUSE the SaaS, harvest
  its IP into manual/agency work" decision in `AuditService/INCOME_PLAN.md:166`.)
- **Autonomy = observe → graduate.** Every client starts in `observe` (recommend-only).
  Tier-A spend-reducing actions (pause, decrease budget) may auto-execute only after the
  operator graduates that client to `tier_a`. Tier-B (launch, increase budget, targeting)
  is always human-approved. Kill switch always armed. This is exactly what Meta-Manager's
  `WRITE_MODE` two-gate design already supports — make it **per-client**.

---

## 1. Current state (what exists — build on this, don't restart)

Three assets, only one of which is the foundation:

1. **`ADS/Meta-Manager/` — THE FOUNDATION (build here).** Electron + Next.js 16 + TS,
   Drizzle/Postgres. Production-grade and well-tested. Already built and live-wired
   (needs credentials only):
   - Meta Marketing API client `src/lib/meta/client.ts` — insights read, `applyAbsolutePatch`
     (the sole write primitive), `verifyAccess`, budget introspection, launch saga
     (`createAdCreative`/`createAdObject`, PAUSED-by-default), `fetchAdLibrary`, CAPI `sendConversion`.
   - **Guardrail engine** `src/lib/guardrails.ts` — default-deny `evaluate()`: env+DB
     WRITE_MODE (min of the two), kill switch, observe gate, policy-version check,
     unresolved-write block, stale-metrics block, **server-computed account spend cap**,
     Tier-A/Tier-B routing, per-action delta caps.
   - **Executor/ledger** `src/lib/automation.ts` — `executeAdAction` is the *single sole
     writer*, serialized, with `preflightAction` re-running full guardrails at write time,
     `ad_actions` status lifecycle, idempotency keys, crash recovery (`recoverOrphanedWrites`).
   - **Optimizer** `src/lib/optimizer.ts` — 7-day rule engine, confidence gates, anti-thrash
     cooldown, blast-radius cap; emits proposals only.
   - **Scheduler** `src/lib/scheduler.ts` — in-process: insights poll /15 min, optimize daily 09:00.
   - Schema `src/db/schema.ts` (14 tables), credential UI (`env-file.ts`,
     `api/settings/env`), metrics, creatives, leads, research, AI copy.
2. **`ADS/meta-ads-automation/` — BLUEPRINT ONLY, mortgage-specific. HARVEST 1 IDEA, DISCARD REST.**
   No code. Its `change_request`/two-key/compliance-gate design is good *thinking*, but
   Meta-Manager already implements ~all of it as `ad_actions` + guardrails. The **only** thing
   to harvest is the **compliance-gate pattern** (§5) — and even that must be re-shaped from
   mortgage law (ECOA/RESPA/Special-Ad-Category Credit) to **med-spa health-ad policy**.
3. **`AuditService/` — the sales pipeline that must feed the engine.** `proposal-closer`
   currently claims it routes "approved fixes … as change_requests" to the (nonexistent)
   `meta-ads-automation` path — this is a **dangling reference to wire up** (§4).

---

## 2. The five workstreams (what actually changes)

Multi-client is **not a feature flag** — it is schema + credentials + per-client control +
account-context threading + hosting. Five workstreams, roughly in dependency order:

### WS-1 — Client scoping (the central change)
- Add a **`clients`** table: `{ id, name, status, meta_account_id, page_id, pixel_id,
  system_user_token (encrypted at rest), created_at }`. (Under one agency System User you may
  share one token across N client ad accounts — but code must still select the account per call.)
- Add `client_id` FK to **every operational table**: `ad_actions`, `creatives`, `ads`,
  `leads`, `competitor_creatives`, `experiments`, and all metric tables. (`meta_insights_daily`
  already has a `meta_account_id` column — generalize that pattern, then actually scope reads by it.)
- Convert the **singleton `automation_control`** (`id boolean primary key default true`) into
  **per-client control rows**: each client gets its own `writeMode`, kill switch, spend caps,
  and optimizer CPA/ROAS targets. Keep one **global agency master kill switch + global
  `WRITE_MODE` env gate** layered *above* per-client mode (effective = min of global and client).
- Thread a **`client_id` / credential context** through: the Meta client (stop reading
  `process.env.META_*` globals in `meta/client.ts`; pass an explicit account/token context),
  guardrail context, `executeAdAction`, optimizer aggregation, scheduler poll, and every
  `list*`/approval API route. **Grep-verify zero unscoped operational queries remain.**

### WS-2 — Credentials store & per-client onboarding
- Replace the single-`.env` credential model (`env-file.ts`, `api/settings/env`) with an
  **encrypted per-client credentials store** in the DB (token encrypted; never logged, never in URLs).
- Build a **client-onboarding flow**: operator adds a client → client assigns their Ad
  Account + Page + Pixel to the agency Business/System User → `verifyAccess()` round-trip
  confirms connectivity before the client goes "active."

### WS-3 — Always-on hosting (off the desktop)
- Move the Next.js server + scheduler from the Electron desktop app to a **hosted, always-on
  server** so automation runs 24/7 (today it only runs while the app window is open; the
  native Meta spend cap is the *only* current 24/7 backstop).
- Replace the **in-process scheduler + in-process mutex** with a **durable job queue +
  Postgres advisory locks** (the code already flags this as the `ponytail:` upgrade for
  multi-account/multi-instance). Per-client poll + optimize loops.
- Minimal **operator auth** in front of the hosted app (today: "localhost only, no auth").
  Single operator now; leave a seam for multiple operators each owning a client subset.

### WS-4 — Pipeline wiring (audit → engine)
- Make `proposal-closer`'s handoff **real** (§4): define the contract that turns an approved
  `proposal.md` line item into an `ad_actions` proposal row (the existing approval primitive),
  scoped to the client. **Repoint `proposal-closer` away from the dead `meta-ads-automation/`
  path to Meta-Manager.**

### WS-5 — Med-spa compliance gate (harvest + replace)
- Add a synchronous **compliance pre-check** before a proposal can reach `pending_approval`
  (harvest the blueprint's gate *pattern*), but with **med-spa rules, not mortgage** (§5).

---

## 3. What "fully wired" means end-to-end

Target happy path, per client:
`audit (ads-audit/audit-meta) → proposal-closer proposal.md → operator approves →
mapped to ad_actions proposal rows (WS-4) → compliance pre-check (WS-5) → guardrail evaluate
→ [observe: queued for manual apply] OR [tier_a: spend-reducing auto-executes] OR
[tier_b: human approval] → executeAdAction → applyAbsolutePatch/launch saga → reconcile →
audit_events → metrics poll picks up result → monthly one-page client report.`

---

## 4. The handoff contract (proposal-closer → engine) — define this explicitly

`proposal-closer` today specifies only: artifact = `change_requests`, two guarantees
("approval-gated", "compliance-checked"), one prohibition ("never run ads ad hoc"). It defines
**no fields**. The dev team must define the mapping. Recommended: **reuse `ad_actions`** (don't
invent a parallel `change_requests` table — Meta-Manager already models proposal→approval→apply
as `ad_actions` status transitions). Per approved proposal line item, emit an `ad_actions` row:
- `client_id`, `entity_type` (campaign/adset/ad/creative), `entity_ref` (Meta object id or
  internal creative id), `action_type` (map fix → `pause_* | set_budget | decrease_budget |
  increase_budget | launch_ad | change_targeting | create_*`), `current_value`, `proposed_value`,
  `rationale` (must trace to an audit finding — no fabricated ROI), `confidence`, `source: 'proposal'`.
- It enters the **same** guardrail/executor path as optimizer-generated proposals. No second code path.
- **Repoint** `proposal-closer/SKILL.md` step 5 + guardrails + frontmatter from
  `/home/.../ADS/meta-ads-automation/` to the Meta-Manager engine + this contract.

The "five fixes almost every time" from `AuditService/PROCESS.html` (enable CAPI/Lead event,
one clean Leads campaign, real offer, 3 static creatives, speed-to-lead) are the canonical
proposal line items to support first.

## 5. Compliance gate — replace mortgage rules with med-spa rules
Keep the gate *pattern* (synchronous PASS/FLAG/BLOCK chokepoint before approval; immutable
audit of every evaluation incl. rule version). Replace the rule content:
- **DELETE:** ECOA/Fair-Lending, RESPA referral/fee, Special-Ad-Category=Credit, rate/APR claims.
- **KEEP:** TCPA (generic to any SMS/call follow-up — directly relevant to med-spa speed-to-lead).
- **ADD (med-spa health-ad policy):** no implied personal-health-attribute targeting; no
  "you/your body" before-after framing (Meta health policy, already named in `PROCESS.html`);
  FTC "results not typical" / before-after substantiation; no implied medical outcomes;
  pricing-offer legitimacy. Ship as a **versioned ruleset**; one optional per-client exclusion list.

## 6. Meta App Review & credential prerequisites (hard gate — start early, long lead time)
- **System User token** (never-expiring) with scopes `ads_management`, `ads_read`,
  `business_management` (+ `read_insights`). (Env keys today: `META_SYSTEM_USER_TOKEN`,
  `META_AD_ACCOUNT_ID`, `META_APP_ID/SECRET`, `META_PAGE_ID`, `META_PIXEL_ID`, `META_API_VERSION`.)
- **Advanced Access / App Review is REQUIRED** to manage ad accounts you don't own
  (agency/multi-account) and for usable rate limits. `META_SETUP.md` confirms own-account works
  in Dev/Standard, but **agency = App Review on `ads_management`/`ads_read`**. **This is the
  critical-path prerequisite — submit the app for review in parallel with WS-1.**
- Per-client asset-grant onboarding (client assigns Ad Account + Page + Pixel to agency Business).

## 7. Sequenced milestones
1. **M0 — Prereqs (parallel from day 1):** submit Meta App Review (Advanced Access). Stand up
   hosted Postgres + deploy target. *Gate: review submitted.*
2. **M1 — Client scoping (WS-1):** schema migration + account-context threading + per-client
   control. *Gate: two test clients fully isolated; grep shows no unscoped operational queries;
   guardrail tests pass per-client.*
3. **M2 — Credentials + onboarding (WS-2):** encrypted store + onboarding flow + `verifyAccess`.
   *Gate: add a real client end-to-end in observe mode; live insights read.*
4. **M3 — Hosting + durable scheduler (WS-3):** hosted always-on, durable queue + advisory
   locks, operator auth. *Gate: 24/7 poll/optimize per client; kill switch works hosted.*
5. **M4 — Pipeline wiring (WS-4):** proposal → `ad_actions` mapping; repoint `proposal-closer`.
   *Gate: an approved proposal.md produces correctly-scoped proposal rows in observe mode.*
6. **M5 — Compliance gate (WS-5):** med-spa ruleset. *Gate: a non-compliant creative/targeting
   change is BLOCKed before approval; audit logged.*
7. **M6 — First live client graduation:** run one real client observe → tier_a. *Gate: a
   Tier-A pause auto-executes within caps; Tier-B launch requires approval; spend cap holds.*

## 8. Acceptance criteria (production-ready = all true)
- Two+ client accounts managed in full isolation (no cross-client read/write/spend-cap bleed).
- Per-client WRITE_MODE + per-client kill switch + global agency master kill switch.
- Engine runs 24/7 hosted; recovers cleanly from restart (orphaned writes → `uncertain`).
- Server-side spend cap recomputed from live Meta reads per client; fails closed.
- Approved audit fixes flow from `proposal-closer` into scoped proposal rows automatically.
- Compliance gate blocks non-compliant med-spa changes pre-approval, with audit trail.
- Advanced Access granted; a real client's account managed via the agency System User.

## 9. Non-goals (anti-sprawl — explicitly out of scope)
- No multi-tenant SaaS / RBAC / RLS / PII-vault plane-split (that's Path B — not now).
- No new `change_request` table — reuse `ad_actions`.
- No rebuild of guardrails/executor/optimizer/Meta-client — extend, don't replace.
- No mortgage-CRO logic. No full autonomy at launch (observe→graduate only).
- No nurture/email-sequence engine (Module 9 stays a stub) beyond the existing speed-to-lead.

## 10. Verification / how to test
- **Per-milestone gates above** are the test plan. Use Meta-Manager's existing test suites
  (`guardrails.test.ts`, `optimizer.test.ts`, `metrics.test.ts`) as the regression base; extend
  each to assert **per-client** isolation.
- **Live dry-run before any client spend:** connect the operator's *own* Meta account first,
  run M2–M3 in `observe`, confirm insights + proposals with zero writes, then exercise one
  `tier_a` pause on a throwaway campaign before onboarding a paying client.

## Key files to anchor the work
- Engine: `ADS/Meta-Manager/src/lib/{guardrails,automation,optimizer,scheduler,metrics}.ts`,
  `src/lib/meta/client.ts`, `src/db/schema.ts`, `src/lib/{connection,env-file}.ts`,
  `docs/{ARCHITECTURE,PRODUCT_SPEC,META_SETUP,LIVE_TESTING}.md`.
- Handoff: `~/.claude/skills/proposal-closer/SKILL.md` (steps 5 + guardrails + frontmatter).
- Harvest-only (compliance pattern): `ADS/meta-ads-automation/phase1-design.md` §3,
  `architecture-spec.md` §7.
- Domain truth (fixes, retainer rhythm, compliance phrasing): `AuditService/PROCESS.html`
  steps 12–17; `AuditService/INCOME_PLAN.md` lines 60–70, 151–168.
