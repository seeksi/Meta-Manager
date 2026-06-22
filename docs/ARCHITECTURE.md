# Meta Ads Manager — Architecture & Decisions (Phase 1)

Single-brand, single-operator Meta Ads management web app. One person runs the whole ad
account from a browser: monitor metrics, adjust budgets, upload creatives, build/launch
ads, generate copy, research competitors, and run tiered ad-settings optimization.

> Decisions below were cross-checked with Claude Council (codex / gpt-5.5). Every choice
> lists a one-line rationale and the rejected alternative. Bias: boring, robust,
> minimal-code — because this writes to a live ad budget.

---

## 1. Stack decisions

| Concern | Decision | Rationale | Rejected |
|--------|----------|-----------|----------|
| Shell | **Electron desktop app** wrapping the Next.js server (standalone output, booted by `electron/main.js`) | Single-operator desktop-first; runs locally with no deploy; Next server + API routes + scheduler reused as-is | Tauri (would force a static-frontend rewrite); hosted-only (still needs cloud) |
| Framework | Next.js App Router + TypeScript (standalone server) | Server actions, long-running funcs, all logic reused inside Electron | Separate SPA + API server (more infra) |
| DB | **Neon Postgres** via Vercel integration; pooled conn at runtime, direct conn for migrations | Serverless-friendly, boring SQL, Vercel-native | Vercel Postgres (discontinued), Supabase (more than we need) |
| ORM | **Drizzle** | Explicit, type-safe SQL — matters for spend controls, row locks, rollups, audits | Prisma (less SQL visibility for spend-critical paths) |
| Creative storage | **Vercel Blob** (images + video); Postgres holds metadata, hashes, review state, Meta creative IDs | Native, public+private, zero infra | S3 (extra creds/infra) |
| Background jobs | **In-process scheduler** (`src/lib/scheduler.ts`, started from `instrumentation.ts`) | Desktop app is single-instance; stdlib timers need zero infra and run while the app is open | Inngest Cloud (durable cloud cron — overkill once we left Vercel for a local desktop app) |
| Scheduler | `setInterval`/`setTimeout` in the Node server runtime | Insights every 15 min + optimizer daily at 09:00 local; native Meta spend cap is the 24/7 backstop for hours the app is closed | Vercel Cron (no longer deployed to Vercel) |
| Metric storage | **Plain Postgres**: raw fetch logs + canonical daily/hourly insight tables + rollup tables | Start boring; add monthly partitioning + BRIN indexes only when large | TimescaleDB (premature; extra extension/ops) |
| AI copy | Vercel AI SDK via **AI Gateway**, default current Claude model, **structured outputs** (`Output.object`) | Schema-validated copy = no parsing/format drift | Free-form text generation (fragile to parse) |
| Auth | Single operator → minimal auth (one-account, e.g. Clerk or a single gated session) | No multi-tenancy needed | Full RBAC/org model (YAGNI for one user) |

`ponytail:` auth ceiling = single operator. Upgrade to multi-tenant org/roles only if this
becomes an agency tool.

---

## 2. Module map → UI surface

| # | Module | UI surface (page/panel) |
|---|--------|--------------------------|
| 1 | Meta API onboarding | `/settings/connection` — guided connect flow (app, token, Pixel/CAPI) |
| 2 | Metrics monitoring & display | `/` dashboard — KPI cards, charts, date-range filter, per-campaign drilldown |
| 3 | Budget management | `/campaigns/[id]` budget editor panel — view/adjust, guardrail-validated |
| 4 | Creative & ad upload/assembly | `/creatives` library + `/ads/new` ad builder (creative + copy + CTA + destination + preview) |
| 5 | AI copywriting | inline generator panel inside the ad builder (variants → edit → attach) |
| 6 | Lead funnel management | `/leads` — pipeline stages, funnel analytics |
| 7 | Competitor creative research | `/research` — Ad Library browser, saved creatives, pattern tags |
| 8 | Settings optimization & auto-launch | `/optimize` — recommendations queue + launch controls |
| 9 | Lead conversion / monitoring / retention | `/leads` lifecycle + nurture triggers |
| — | Autonomy control | `/automation` — write-mode, caps, **kill-switch**, approval queue, audit log |

### Sitemap / navigation
```
/                      Dashboard (metrics)
/campaigns             Campaign list
  /campaigns/[id]      Detail + budget editor
/ads/new               Ad builder (+ AI copy)
/creatives             Creative library
/research              Competitor research
/leads                 Lead funnel + lifecycle
/optimize              Optimization recommendations
/automation            Guardrails, approval queue, audit log, kill-switch
/settings/connection   Meta onboarding / tokens / Pixel-CAPI
```

---

## 3. Meta API integration design

Owned by the `meta-api-integrator` agent. **One rule above all: no code path writes to
Meta except the single action executor.** UI actions, AI output, and the optimizer only
ever create rows in `ad_actions` (proposed). The executor (`executeAdAction` in
`src/lib/automation.ts`, called only via `dispatch`) is the sole writer.

- **Auth:** Business/Developer app → app review → system-user token; scopes `ads_management`,
  `ads_read`, `business_management`. Pixel + CAPI for conversions (event_id dedup, PII hashing).
  Marketing API version pinned to one config constant. Onboarding is a guided UI flow; token
  flow stubbed until app approval lands (clear TODO at the boundary).
- **Reads (insights):** polled on a cadence, written to Postgres. UI reads the DB and shows
  **data freshness**; it never calls Meta live on dashboard load.
- **Writes:** only via executor, using **absolute target writes** (`daily_budget = 12500`,
  never "increase 10%") so retries are safe. On post-write timeout → mark action `uncertain`,
  reconcile from Meta before any retry. Never blindly retry create/budget-increase.
- **Backstop:** set a **native Meta account/campaign spend cap** outside the app as the final
  line of defense.

### Polling cadence
| Window | Cadence |
|--------|---------|
| Active campaigns, "today" | every 10–15 min |
| Yesterday / last 7 days (attribution shifts) | every few hours |
| Older windows | daily |

---

## 4. Data model (key tables)

```sql
-- Metrics (plain Postgres + rollups; partition/BRIN when large)
metric_fetches(id, source, fetched_at, request jsonb, response jsonb);
meta_insights_daily(
  meta_account_id, entity_type, entity_id,
  date_start, date_stop, breakdown_hash,
  impressions, spend_cents, clicks, purchases, revenue_cents,
  fetched_at, fetch_id,
  unique(meta_account_id, entity_type, entity_id, date_start, date_stop, breakdown_hash)
);
meta_insights_hourly(... same shape ...);
metric_rollups_daily(day, entity_type, entity_id, spend_cents, roas, cpa, ctr, updated_at);

-- Autonomy engine
automation_control(            -- singleton row
  id boolean primary key default true,
  write_mode text not null,    -- off | observe | tier_a | all
  emergency_stop boolean not null default true,   -- KILL SWITCH
  max_account_daily_spend_cents int not null,
  max_action_budget_delta_cents int not null,
  max_action_budget_delta_pct numeric not null,
  min_metric_freshness_minutes int not null,
  active_policy_version int not null,
  updated_at timestamptz not null, updated_by text not null
);
ad_actions(
  id uuid primary key, tier text,  -- A | B
  status text,  -- proposed|blocked|pending_approval|approved|executing|succeeded|failed|uncertain
  action_type text, entity_type text, entity_id text,
  target_state jsonb, evidence jsonb, guardrail_result jsonb,
  policy_version int, idempotency_key text unique,
  expires_at timestamptz, created_at timestamptz
);
action_attempts(id uuid primary key, action_id uuid, attempt int, meta_request jsonb, meta_response jsonb, error text, created_at timestamptz);
audit_events(id uuid primary key, actor text, event_type text, subject_id text, before jsonb, after jsonb, reason text, action_id uuid, created_at timestamptz);
spend_reservations(action_id uuid primary key, day date, delta_daily_budget_cents int, status text);

-- Creatives / ads / leads
creatives(id, blob_url, type, hash, meta_creative_id, review_state, created_at);
ads(id, creative_id, copy jsonb, cta, destination_url, campaign_id, adset_id, meta_ad_id, status);
leads(id, source, stage, score, captured_at, last_activity_at, attributes jsonb);
```

---

## 5. Autonomy engine

**Pipeline:**
```
poll metrics → optimization_run → proposed ad_action
→ guardrail evaluation
   → Tier A: queued for execution
   → Tier B: pending approval (in-UI, with diff + projected cost)
→ preflight guardrail re-check (at execution time)
→ Meta API write (executor only)
→ reconcile from Meta
→ append audit events
```

**Tiers:**
- **Tier A (auto, within hard caps):** pause losers, pause ad/adset, *decrease* budget,
  small absolute budget target changes within daily caps. Never: create campaigns, expand
  audiences, unpause, change conversion events, or materially increase spend.
- **Tier B (in-UI approval):** new campaigns/adsets/ads, creative launch, audience expansion,
  unpause, budget increases above a tiny threshold, targeting changes. Approval **expires**
  and is **re-checked** at execution.

**Guardrail evaluation (default-deny):**
```ts
function evaluate(action, ctx): GuardrailResult {
  if (ctx.envWriteMode === "off") return block("ENV_WRITE_DISABLED");
  if (ctx.control.emergencyStop || ctx.control.writeMode === "off") return block("KILL_SWITCH");
  if (action.policyVersion !== ctx.control.activePolicyVersion) return block("POLICY_CHANGED");
  const spendReducing = ["pause_ad","pause_adset","decrease_budget"].includes(action.actionType);
  if (!ctx.metricsFresh && !spendReducing) return block("STALE_METRICS");
  if (!TIER_A_ACTIONS.has(action.actionType)) return requireApproval("TIER_B_ACTION");
  if (action.dailyBudgetDeltaCents > ctx.control.maxActionBudgetDeltaCents) return requireApproval("DELTA_TOO_LARGE");
  if (action.dailyBudgetDeltaPct  > ctx.control.maxActionBudgetDeltaPct ) return requireApproval("PCT_TOO_LARGE");
  if (ctx.projectedDailySpendCents > ctx.control.maxAccountDailySpendCents) return block("ACCOUNT_CAP");
  return allow("TIER_A_ALLOWED");
}
```

**Default-deny triggers:** DB read fails, metrics stale, Meta state unknown, policy version
changed, or cap math uncomputable → block all spend-increasing writes.

**Executor (inline, preflight → apply → reconcile):** the sole Meta writer. Runs
synchronously from `dispatch`; the Meta client retries transient errors internally and
ambiguous writes are marked `uncertain` for reconciliation on the next poll.
```ts
export async function executeAdAction(actionId: string) {
  const pre = await preflightAction(actionId);              // re-check guardrails at write time
  if (!pre.allowed || !pre.metaPayload)
    return reconcileAction(actionId, { ok: false, error: `preflight: ${pre.reason}` });
  let applied;
  try { applied = await applyAbsolutePatch(pre.metaPayload); } // absolute target — safe to retry
  catch (e) { await markUncertain(actionId, String(e)); return; }
  return reconcileAction(actionId, { ok: applied.ok, metaResponse: applied.metaResponse });
}
```

**Kill-switch:** `automation_control.emergency_stop` flips all writes off instantly,
reachable from every page header. Native Meta spend cap is the external backstop.

**Durable intent & recovery (desktop, no durable queue):** the `ad_actions` ledger is the
durable record of intent/uncertainty. On startup `recoverOrphanedWrites()` demotes any action
left `executing` (crash mid-write) to `uncertain` — never assumed applied. The guardrail engine
fails closed on unresolved state: while any write is `executing`/`uncertain`, spend-increasing
proposals are blocked (`UNRESOLVED_WRITES`); pauses/decreases remain allowed. An operator can
resolve an `uncertain` action after verifying remote state (`/api/actions/[id]/resolve`).
ponytail: auto-reconcile `uncertain` against live Meta reads (meta-api-integrator) once read
paths are credentialed, so resolution needs no operator step.

---

## 6. Phased roadmap

**MVP** (Phase 3 scaffold + first modules)
- Meta connect flow (token stubbed), metric ingestion cron → Postgres, dashboard with KPI
  cards + freshness, campaign list + budget editor (writes via executor), `automation_control`
  + kill-switch + approval queue core, audit log. Creative library + ad builder + AI copy
  (structured output). Manual launch only (everything Tier B).

**v1**
- Optimization engine emits Tier A proposals (pause losers, decrease budget) auto-executing
  within caps; Tier B approval UX with diffs + projected cost. Lead funnel capture + stages.
  Competitor research browser (Ad Library + Apify ingest).

**v2**
- Lead scoring + nurture/retention triggers, richer rollups + partitioning/BRIN at scale,
  creative fatigue detection, hourly insights, expanded Tier A action set.

**Deferrable:** multi-tenancy/RBAC, Timescale, Vercel Workflow migration (after GA), advanced
attribution modeling.

---

## 7. Optimizer (module 8) — Council-informed

Cross-checked with Claude Council (codex). Stance: **auto-pause obvious losers, auto-cut
cautiously, never auto-scale** — growth/restructuring/relaunch are always Tier B.

- **Window:** 7-day primary lookback (not single-day — avoids acting on noise), aggregated per campaign.
- **Confidence gates** before judging: min spend ($50), min impressions (1000) / clicks (20),
  min conversions (3) before trusting CPA/ROAS.
- **Tier A pause:** zero conversions past 3× target CPA in spend; or CPA ≥ 3× target (with ≥3 conversions).
- **Tier A decrease:** converting but ROAS ≤ 50% of target → cautious budget cut (needs current budget from Meta).
- **Tier B only:** budget increases / scaling (strict gates: stable history, ≥5 days since last change).
- **Anti-thrash:** per-entity cooldown + **deterministic idempotency key** (`opt:entity:action:rule`)
  so repeat runs don't duplicate proposals; never auto-relaunch a paused entity.
- **Blast radius:** capped proposals per run, worst-first.
- **Evidence:** each proposal carries rule id, window, targets, metrics, and passed gates for the
  approval diff + audit.
- **Deferred (needs Meta delivery fields):** learning-phase soft-lock, frequency, ageHours,
  current-budget diffs, stale-proposal cancellation. Owned by meta-api-integrator.

---

skipped: multi-tenant auth, Timescale, hourly insights — add when scale/agency need appears.
skipped: optimizer learning-phase/frequency gating — needs Meta delivery fields (meta-api-integrator).
