# M4 — Pipeline Wiring (audit → engine) · build-orchestrator task prompt

> Paste this to the **build-orchestrator** agent. Executable brief for milestone **M4** of
> `docs/AGENCY_BUILD_SPEC.md` (WS-4). **Depends on M1+M2+M3.** Write M4 **against the code that
> actually landed**, not the spec prose — read the anchor files first. Do **only** M4. WS-5
> (compliance gate) stays out.

---

## Read first — the real state M4 builds on
The engine side of this milestone **already exists**; M4 is mostly a contract + a thin adapter +
a skill rewrite. Respect the seams already there:
- **`src/lib/automation.ts`** — `proposeAction(input)` already does the whole approval primitive:
  build per-client guardrail context → `evaluate` → persist an `ad_actions` row
  (`status` = `approved` | `pending_approval` | `blocked`) → `audit(...)` → auto-`dispatch` when
  allowed. `ProposeInputSchema` is `.strict()` and already accepts `actor`, `evidence`,
  `idempotencyKey`. **This is the only write path; do not add a second one.**
- **`src/app/api/actions/route.ts`** — `POST /api/actions` validates `ProposeInputSchema`,
  resolves `clientId` (`resolveClientId`, defaults to `BOOTSTRAP_CLIENT_ID`), calls
  `proposeAction`. **This is the ingestion point M4 feeds.**
- **`src/lib/guardrails.ts:6`** — `ACTION_TYPES` is the single source of truth for valid
  `actionType`s. The importer imports this enum (the file is pure, no DB side-effects).
- **`src/db/schema.ts:134` (`adActions`)** — has `idempotencyKey` (unique, `onConflictDoNothing`),
  `evidence` jsonb, `status` lifecycle, `tier`. `audit_events` records `actor`. **No `source`
  column and none is added** — origin is tagged via `actor='proposal-closer'` + `evidence`.
- **Auth (M3):** login/session exist (`src/lib/auth.ts`, `/api/auth/login`) but no middleware yet,
  so `/api/actions` is currently open. The importer logs in when `OPERATOR_USERNAME/PASSWORD` are
  set so it keeps working once G4 gating is completed.
- **Sales side:** `~/.claude/skills/proposal-closer/SKILL.md` previously dead-ended at the
  abandoned `ADS/meta-ads-automation/` workflow as `change_requests`. M4 repoints it here.

## Mission
Make `proposal-closer`'s handoff **real**: an approved `proposal.md` line item becomes a
**correctly-scoped `ad_actions` proposal row** in the engine, entering the *same*
guardrail/executor path as optimizer proposals. **Done =** an approved proposal.md produces
correctly-scoped proposal rows in `observe` mode (zero Meta writes), and re-running it creates no
duplicates.

## Decisions already locked (do not re-litigate)
- **Ingestion = reuse `POST /api/actions`.** No new endpoint, no engine changes.
- **Origin tag = reuse `actor='proposal-closer'` + `evidence={auditFinding, proposalId, proposalPath}`.**
  No schema migration, no `source` column (overrides the spec's literal `source:'proposal'` in
  favor of the Ponytail minimal-code rule).

## Routing (delegate; don't re-derive)
- Importer adapter + skill contract: **backend** / skill-author.
- **No `database` skill** (no migration). **No meta-api-integrator** (no `client.ts` change).

## Concrete subtasks

### 1. The handoff contract — the ` ```actions ` block
A `proposal.md` stays human-readable; the mappable fixes live in **one fenced ` ```actions `
JSON array** (JSON, not YAML — `JSON.parse`, zero parser dependency). Each object:
`actionType` (one of `ACTION_TYPES`), `entityType` (account|campaign|adset|ad), `entityId` (real
Meta object id; unknown → manual checklist), `targetState` (ABSOLUTE target, never a delta),
`dailyBudgetDeltaCents` + `projectedDailySpendCents` (budget actions only — guardrail caps read
these), `auditFinding` (required — traces to an audit finding, no fabricated ROI).
```actions
[
  { "actionType": "pause_campaign", "entityType": "campaign", "entityId": "120210000000001",
    "targetState": { "status": "PAUSED" }, "auditFinding": "0 booked leads (audit §3)" },
  { "actionType": "decrease_budget", "entityType": "adset", "entityId": "120210000000777",
    "targetState": { "daily_budget": 2000 }, "dailyBudgetDeltaCents": -3000,
    "projectedDailySpendCents": 2000, "auditFinding": "CPA 4x target (audit §5)" }
]
```
Fixes with **no valid action_type** (enable CAPI/Lead event, real offer copy, 3 static creatives
needing assets, speed-to-lead routing) are **NOT** in the block — they go in a **Manual
onboarding tasks** checklist. First-class mappable items: `pause_campaign`/`pause_ad` (wasted
spend), `decrease_budget`/`set_budget` (reallocation), and (Tier-B, approval-gated)
`create_campaign` for "one clean Leads campaign".

### 2. The importer adapter — `scripts/import-proposal.ts` (already written)
Thin `tsx` CLI, no new deps (`JSON.parse` + `zod` already present — deliberately no YAML parser):
- `--file <proposal.md> --client <uuid|name> [--base URL] [--dry-run]`. Name → uuid via
  `GET /api/clients`; uuid passes through; default base `http://localhost:3000`.
- Optional login (when `OPERATOR_USERNAME/PASSWORD` set) → carries the `mam_session` cookie.
- Parses the single ` ```actions ` JSON block, validates each item against a local mirror of
  `ProposeInputSchema` (+ required `auditFinding`).
- Per item: `POST /api/actions` with `actor:'proposal-closer'`,
  `evidence:{auditFinding, proposalId, proposalPath}`, and a **deterministic** `idempotencyKey`
  = `proposal:sha256(clientId:actionType:entityId:auditFinding)` so re-imports don't duplicate.
- `--dry-run` is a fully offline lint (validate + print, no network).

### 3. Repoint `proposal-closer/SKILL.md` (already done)
frontmatter description, step 4 (emit the block + manual checklist split), step 5 (run the
importer against Meta-Manager), and Guardrails now reference the `ad_actions` pipeline. The dead
`meta-ads-automation/` path and `change_requests` artifact language are removed.

## Non-negotiables (enforce)
- **Minimal-code (Ponytail):** no new endpoint, no new table/migration, no second write path.
- **Spend safety preserved end-to-end:** proposals enter via `proposeAction` →
  `evaluate`/`preflightAction`; M4 opens no path from "proposed" to a Meta write that skips the
  gate. Observe→graduate untouched (rows are created, not executed, in `observe`).
- **Every row traces to an audit finding** (`auditFinding` required; lands in `evidence`).
- **Don't rebuild M1–M3:** per-client scoping, `proposeAction`, guardrails, auth stay as-is.

## Phase gates (pause for "continue" after each)
- **G1 — contract + importer:** ` ```actions ` contract documented; `scripts/import-proposal.ts`
  passes `--dry-run` on a sample proposal (schema + ACTION_TYPES validation). Summarize.
- **G2 — live observe-mode import:** against a running engine with a client in `observe`, the
  importer creates one correctly-scoped `ad_actions` row per item, `evidence.auditFinding`
  populated, `audit_events.actor='proposal-closer'`, **status ≠ executed**, **zero Meta writes**;
  re-run → no duplicates. Cross-client isolation test green. Summarize.

## Acceptance (M4 complete)
- An approved `proposal.md` → correctly-scoped `ad_actions` proposal rows in observe mode.
- Re-importing the same approved proposal creates no duplicate rows (idempotency proven).
- `proposal-closer` points at Meta-Manager; no remaining `meta-ads-automation`/`change_requests`
  references.
- Full suite green incl. a new test: importing a proposal for client A never creates a row for
  client B.

## Anchor files
`scripts/import-proposal.ts` (new) · `src/lib/automation.ts` (`proposeAction`,
`ProposeInputSchema`) · `src/app/api/actions/route.ts` · `src/lib/guardrails.ts:6`
(`ACTION_TYPES`) · `src/lib/clients.ts` (clientId resolution) · `src/db/schema.ts:134`
(`adActions`) · `~/.claude/skills/proposal-closer/SKILL.md` (repointed). Spec:
`docs/AGENCY_BUILD_SPEC.md` §2 WS-4, §4 (handoff contract), §7 M4. Depends on M1+M2+M3.

## Run notes
- Branch off `main` after M3 merges; the engine must be running (`npm run dev`) for G2.
- The importer never calls Meta directly — it only feeds `proposeAction`; observe mode is the
  external safety during the dry-run-before-spend window (`docs/LIVE_TESTING.md`).
