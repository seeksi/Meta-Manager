# M3 — Always-On Hosting, Durable Scheduler & Minimal Auth · build-orchestrator task prompt

> Paste this to the **build-orchestrator** agent. Executable brief for milestone **M3** of
> `docs/AGENCY_BUILD_SPEC.md` (WS-3). **Depends on M1+M2** (PR #1, branch `feat/m2-onboarding`).
> Write M3 **against the code that actually landed**, not the spec prose — read the anchor
> files first. Do **only** M3. WS-4 (pipeline wiring) and WS-5 (compliance gate) stay out.

---

## Read first — the real state M3 builds on (M1+M2, already merged in PR #1)
The build is further along than the spec; respect the seams the code already left:
- **`src/lib/scheduler.ts`** — in-process `setInterval` (insights /15m) + self-arming
  `setTimeout` (optimize daily 09:00), module-level `status`. Already loops **per active
  client** (`listActiveClients()` → `clientContext`). Comment: "runs in-process while the app
  is open … the native Meta account spend cap remains the external 24/7 backstop."
- **`src/instrumentation.ts`** — `register()` calls `ensureBootstrapClient()` then
  `startScheduler()` once per Node server instance (skips Edge / `DISABLE_SCHEDULER=1`).
- **`src/lib/automation.ts:344-347`** — `serializeWrite(clientId, fn)` is an **in-process
  per-client mutex**. Its own ponytail: *"durable queue + Postgres advisory locks (held across
  preflight + the Meta write) for multi-instance = WS-3."* ← this milestone.
- **`src/lib/clients.ts`** — `agencyToken()` (ponytail: *"host secret manager in WS-3"*);
  `resolveClientId(req)` defaults to `BOOTSTRAP_CLIENT_ID` (ponytail: *"single-operator
  default; per-operator client ownership/auth is WS-3"*); `ensureBootstrapClient()`.
- **Auth today: none.** No login, no session; every route is open and defaults to the bootstrap
  client. `recoverOrphanedWrites()` runs only at boot.
- **Packaging: Electron** (`package.json main: electron/main.js`, scripts `desktop`/`dist`
  electron-builder AppImage) wrapping the Next standalone server. The scheduler only runs while
  that desktop window is open.

## Mission
Make the engine an **always-on hosted service** that (a) keeps polling/optimizing 24/7 without
the desktop app, (b) is **safe under restart and multiple instances** (no double-writes), and
(c) is **gated by minimal operator auth**. **Done =** kill the process and restart → cadence
resumes + orphans recover; two instances racing the same client cannot double-execute a write;
the app requires login; the agency token comes from a host secret, not a writable `.env`.

---

## ⚠️ Design decision — confirm before G1 (hosting target)
- **Option 1 — single always-on Node host (RECOMMENDED, build this).** Deploy the Next
  standalone server (`next start`) on one always-on container (Fly/Render/Railway/VPS). The
  existing in-process scheduler keeps working *because the process never sleeps* — minimal
  change. Add Postgres advisory locks for write safety + a leader seam for later scale.
  Smallest diff, preserves all working code. Electron stays as an optional local dev shell.
- **Option 2 — Vercel serverless + Cron + durable queue.** Serverless can't hold an in-process
  `setInterval`, so the scheduler must be rewritten into Vercel Cron endpoints feeding a queue
  (QStash/Inngest), and advisory locks become mandatory (many concurrent invocations). Scales
  better; much larger rewrite. Only pick this if hosted-Vercel is a hard requirement.

**Proceed with Option 1.** It matches the Ponytail rule (extend, don't rewrite) and solo-agency
scale. Use Vercel for the marketing site, not the always-on engine. If the operator overrides to
Option 2, route to `vercel:vercel-functions` / `vercel:workflow` / `vercel:vercel-cli` and treat
§"Subtask 2" as a scheduler rewrite rather than a persistence add.

## Routing (delegate; don't re-derive)
- **Queue/locks/auth/session, deploy config:** `backend` skill.
- **Postgres advisory-lock helper + any migration (`operators`/run-ledger):** `database` skill.
- **Login page (minimal):** `frontend` skill. No broad UI work.
- **Meta API code:** still **meta-api-integrator** — but M3 shouldn't need client.ts changes.

## Concrete subtasks (Option 1)

### 1. Always-on hosting (off the desktop)
- Ship a **hosted deployment of the Next standalone server** (Dockerfile + host config) running
  `next start` with `register()`/`startScheduler()` active. This becomes the production engine;
  Electron is demoted to optional local dev (`npm run desktop`), no longer the runtime that
  carries automation.
- **Secrets from the host, not a file:** `agencyToken()` (and `DATABASE_URL`, AI/blob keys) come
  from the host's env/secret store. Resolve the `clients.ts:15` ponytail. On hosted deploys the
  per-account `.env`-writing path (`env-file.ts`, `api/settings/env`) is ephemeral/meaningless —
  gate it to local-dev only or remove it; client account IDs already live in the `clients` table.
- Keep `DISABLE_SCHEDULER=1` honored so a second (web-only) instance can run without scheduling.

### 2. Durable scheduling (survive restarts)
- Persist scheduler cadence so a restart **resumes correctly** instead of resetting timers: a
  small **`scheduler_runs` ledger** (`{ job text, clientId uuid, startedAt, finishedAt, ok,
  result jsonb }`) and "last successful run" lookups so the optimizer fires once/day even across
  restarts (don't double-run if it already ran today; don't skip if the process was down at 09:00
  — run on next boot if missed).
- `recoverOrphanedWrites()` must run **at boot AND on a periodic tick** (not boot-only), since a
  long-lived host reboots rarely — a write left `executing` by a transient crash shouldn't wait
  for the next full restart to demote to `uncertain`.
- Keep the in-process `setInterval`/`setTimeout` (Option 1) but make each tick **idempotent and
  ledger-checked**. ponytail: a real durable queue (QStash/Inngest) is only needed at Option-2 /
  multi-instance scale — mark it, don't build it.

### 3. Postgres advisory locks (multi-instance write safety) — the core correctness deliverable
- Replace the in-process `serializeWrite` mutex (`automation.ts:347`) with a **Postgres advisory
  lock keyed by client** (e.g. `pg_advisory_xact_lock(hashtext('adwrite:'||clientId))`), acquired
  **before `preflightAction` and held across the Meta write + reconcile** in one transaction
  scope — so two app instances (or a scheduler + a UI click) cannot execute writes for the same
  client concurrently. Keep the existing **idempotency key** as the second line of defense
  (`ad_actions.idempotencyKey` unique + `onConflictDoNothing`).
- Preserve every existing invariant: single sole writer (`executeAdAction`), `preflightAction`
  re-running full guardrails at write time, fail-closed on unreadable budgets, `uncertain` on
  post-write timeout. M3 changes *how mutual exclusion is enforced*, nothing about the gate.
- Add a **two-instance regression test**: two concurrent `executeAdAction` calls for one client
  result in exactly one Meta write (the other waits then no-ops via idempotency), and never two.

### 4. Minimal operator auth + ownership seam
- Add **minimal auth** (single operator now): a login + session cookie; gate all pages and all
  `/api/**` routes (today they're wide open). Use a platform-native/already-present approach
  before adding a heavy dep (Ponytail) — a signed session cookie + one operator credential from
  env is acceptable for single-operator; mark the upgrade path.
- Resolve the `resolveClientId` ponytail (`clients.ts:75`) into an **ownership seam**: an
  `operators` concept + operator→client ownership so a future second operator only sees/acts on
  their clients. Implement single-operator now (all clients owned by the one operator); leave the
  multi-operator/RBAC build for later — **do not** build full RBAC here.
- Auth must **not** weaken the autonomy gates: a logged-in operator still can't bypass
  WRITE_MODE, the kill switch, or spend caps.

## Non-negotiables (enforce)
- **Minimal-code (Ponytail):** Option 1 keeps the scheduler and guardrail/executor logic; new
  code is the host/deploy config, the advisory-lock swap, the run ledger, and a minimal login.
  No serverless rewrite, no RBAC, no durable-queue dependency. Mark every deferred seam.
- **Don't rebuild M1/M2.** Per-client scoping, `clientContext`, the verify gate, and Model-A
  token resolution stay exactly as they are.
- **Spend safety / default-deny preserved end-to-end.** The advisory-lock change must not open
  any path from "proposed" to "Meta write" that skips `evaluate` → `preflightAction`.
- **Observe→graduate untouched.** Clients still onboard in `observe` + kill engaged.

## Phase gates (pause for "continue" after each)
- **G1 — hosting:** Next standalone server runs hosted with the scheduler active and no Electron;
  `agencyToken()`/secrets come from the host store; `.env`-write path gated to local-dev.
  Demonstrate a 24/7 run (process stays up, polls fire) and a clean restart. Summarize.
- **G2 — durable scheduling:** `scheduler_runs` ledger + missed-run/duplicate-run handling +
  periodic `recoverOrphanedWrites`. Kill mid-day, restart → optimizer state correct, orphans
  recovered. Summarize.
- **G3 — advisory locks:** mutex swapped to `pg_advisory_*`; two-instance regression test proves
  exactly-once writes per client; all existing guardrail/executor/isolation tests still green.
  Summarize.
- **G4 — auth:** login gates all pages + `/api/**`; ownership seam wires clients to the operator;
  autonomy gates still enforced for a logged-in user. Summarize.

## Acceptance (M3 complete)
- Engine runs 24/7 hosted with **no desktop app**; survives restart (cadence resumes, orphans
  recovered, optimizer neither double-runs nor silently skips).
- Two concurrent instances cannot double-write a client (advisory-lock + idempotency proven).
- App requires login; agency token + secrets come from the host store, never a writable `.env`.
- Full test suite green incl. the new durable-scheduling + two-instance + auth tests.
- Hand back: files changed, any migration, the hosting/deploy config, test results, and the
  seams left for WS-4 (the audit→`ad_actions` pipeline mapping) so M4 picks up cleanly.

## Anchor files
`src/lib/scheduler.ts` · `src/instrumentation.ts` · `src/lib/automation.ts` (`serializeWrite`
~L347, `executeAdAction`, `recoverOrphanedWrites`) · `src/lib/clients.ts` (`agencyToken`,
`resolveClientId`, `ensureBootstrapClient`) · `src/app/api/settings/env/route.ts` +
`src/lib/env-file.ts` (gate to local-dev) · `package.json` / `electron/main.js` (demote to dev) ·
new deploy config (Dockerfile/host) · new `operators`/`scheduler_runs` migration. Spec:
`docs/AGENCY_BUILD_SPEC.md` §2 WS-3, §7 M3. Depends on PR #1 (M1+M2).

## Run notes (for whoever executes this)
- **Branch base:** branch off `main` **after PR #1 merges**; if you must start sooner, branch off
  `feat/m2-onboarding`. One build session per repo — **do not run M3 while the M0 publish/App-Review
  session is still active** (it's currently updating `docs/M0-publish-session-log.md`).
- Run **interactively** and honor gates G1→G4 (review each diff before continuing), as with M1/M2.
