# M1 — Client Scoping · build-orchestrator task prompt

> Paste this to the **build-orchestrator** agent (`.claude/agents/build-orchestrator.md`).
> It is the executable brief for milestone **M1** of `docs/AGENCY_BUILD_SPEC.md` (WS-1).
> Do **only** M1. WS-2..5 (encrypted credential store, hosting, pipeline wiring, compliance
> gate) are explicitly out of scope — leave clean seams, don't build them.

---

## Mission
Make this app manage **multiple client Meta ad accounts in full isolation**, without
rebuilding the guardrail/executor/optimizer logic. Today the app is hard-wired to ONE
account through global singletons. M1 converts it to client-scoped while keeping the single
existing account working throughout (backfilled as the first client).

**Done = two test clients run fully isolated:** no cross-client read, write, spend-cap, or
kill-switch bleed; existing guardrail/optimizer/metrics tests pass per-client; `grep` shows
zero unscoped operational queries and zero `process.env.META_*` reads outside the credential
boundary.

## The four structural singletons to remove (this IS the work)
1. **`automation_control` is a literal singleton** (`src/db/schema.ts` — `id boolean primary
   key default true`). One write-mode, one kill switch, one set of caps/targets for the whole
   install. → becomes **one control row per client**.
2. **`ad_actions` (and most operational tables) have no account/client column.** The executor,
   optimizer, and every `list*` query operate over *all* rows. → add `client_id` everywhere
   and filter by it.
3. **Credentials are process globals.** `src/lib/meta/client.ts` reads
   `process.env.META_SYSTEM_USER_TOKEN` (`token()`) and `process.env.META_AD_ACCOUNT_ID`
   (`acctPath()` default) inside its functions. → the Meta client takes an explicit
   **account/credential context** argument instead.
4. **Scheduler/optimizer loop over "the account."** `src/lib/scheduler.ts` polls the single
   env account; `runOptimization` aggregates unscoped. → loop **per active client**.

## Routing (don't re-derive; delegate)
- **Schema migration + indexes + backfill:** `database` skill. New Drizzle migration in
  `drizzle/` (next number `0007_*`), schema edits in `src/db/schema.ts`.
- **Context threading through lib + API routes:** `backend` skill.
- **Anything in `src/lib/meta/client.ts` (token/account/CAPI/insights signatures):** delegate
  to the **meta-api-integrator** agent. Do not edit Meta API code yourself.
- **Any UI surface (client switcher):** keep minimal; `frontend` skill only if a page must
  change to pick the active client. No new screens beyond a client selector.

## Concrete subtasks

### 1. `clients` table + ClientContext (schema)
Add to `src/db/schema.ts`:
```
clients: { id uuid pk, name text, status text default 'active',  // active|paused|archived
           metaAccountId text notNull, pageId text, pixelId text,
           createdAt timestamptz default now() }
```
- **M1 sources the token from env** for every client (single agency System User token today);
  the per-client **encrypted token store is WS-2** — do NOT build it now. Model a
  `ClientContext = { clientId, accountId, pageId, pixelId, token }` type (new
  `src/lib/clients.ts`) whose `token` comes from `process.env.META_SYSTEM_USER_TOKEN` for now,
  with a `// ponytail: token from env until WS-2 encrypted per-client store` marker. This is
  the ONLY place env credentials may be read after M1.
- `getClient(id)`, `listActiveClients()`, `clientContext(id): ClientContext` live here.

### 2. Per-client `automation_control`
- Change PK from the boolean singleton to **`clientId uuid` (FK → clients.id)**; one row per
  client carrying its own `writeMode`, `emergencyStop`, caps, optimizer targets,
  `activePolicyVersion`. Update `ensureControl`/`getControl`/`setControl`/`engageKill` in
  `src/lib/automation.ts` to take `clientId` and key on it (drop `eq(automationControl.id, true)`).
- **Keep the global agency master gate above per-client:** the env `WRITE_MODE`
  (`ENV_WRITE_MODE` in `automation.ts`) stays as the global master — effective mode already =
  `min(env, control)` in `guardrails.ts::evaluate`, so per-client just means *which* control
  row feeds the context. Add a **global master kill switch** as a tiny `agency_control`
  singleton (`{ id boolean pk default true, emergencyStop boolean default true }`); effective
  kill = `agency.emergencyStop || client.emergencyStop`. Surface both in the kill API
  (`/api/automation/kill`): a per-client stop and an agency-wide stop.

### 3. `client_id` on every operational table + query threading
- Add `clientId uuid notNull (FK)` to: `ad_actions`, `creatives`, `ads`, `leads`,
  `competitor_creatives`, `experiments`, `metric_rollups_daily`, `spend_reservations`.
  (`action_attempts` and `audit_events` inherit scope via `action_id` / `subject` — add
  `clientId` to `audit_events` too so agency-wide audit can filter.) `meta_insights_daily/hourly`
  already carry `metaAccountId` — map `client → metaAccountId` and **actually scope reads by it**
  (today `getDashboardSummary`/`getTimeseries`/optimizer aggregate across whatever is in the table).
- Thread `clientId` through every read/write: `src/lib/{automation,optimizer,metrics,leads,
  creatives,research,experiments}.ts` and every route under `src/app/api/**` (esp.
  `automation/queue`, `automation/control`, `optimize/{run,proposals}`, `actions/*`, `leads/*`,
  `creatives`, `ads`, `experiments`, `insights/*`). `listQueue/listAudit/listUnresolved/
  listProposals` must take and filter by `clientId`.
- **Guardrail context is built per-client:** `buildGuardrailContext(clientId)` loads that
  client's control row, that client's metric freshness, that client's unresolved-write flag,
  and computes `projectedDailySpendCents` from **that client's** account (`fetchEnabledBudgets`
  must run against the client's `accountId`, not the env default). `guardrails.ts::evaluate`
  itself is pure and needs **no change** — only its context source does.

### 4. Meta client takes a context (delegate to meta-api-integrator)
- Replace global `token()` and the env default in `acctPath()` with an explicit
  `ctx: { token, accountId, pageId, pixelId }` parameter on the exported functions
  (`fetchInsights`, `applyAbsolutePatch`, `verifyAccess`, `fetchEnabledBudgets`,
  `createAdCreative`, `createAdObject`, `sendConversion`, `fetchAdLibrary`, budget introspection).
- The executor (`executeAdAction`) and scheduler pass the `ClientContext`'s creds down.
  **Invariant preserved:** the only write primitive is still `applyAbsolutePatch`, still gated
  by `preflightAction` re-running full guardrails at write time — now with the client's context.

### 5. Scheduler/optimizer per client
- `src/lib/scheduler.ts`: poll loop iterates `listActiveClients()` (insights /15 min per
  client against that client's account); optimize-at-09:00 runs `runOptimization(clientId)` per
  client. `recoverOrphanedWrites()` stays global (demote any `executing`→`uncertain`), but
  unresolved-write blocking is evaluated per client.
- **Keep `serializeWrite` as a per-client (or per-`accountId`) mutex**, not one global lock, so
  one client's write doesn't block another's. (Durable queue / advisory locks are WS-3 — leave a
  `// ponytail:` note; in-process per-client mutex is fine for M1.)

### 6. Migration safety / backfill
- The `0007_*` migration must **backfill the existing single account into one bootstrapped
  `clients` row** (from `META_AD_ACCOUNT_ID`/`META_PAGE_ID`/`META_PIXEL_ID`), set every existing
  operational row's `client_id` to it, and migrate the singleton `automation_control` into that
  client's control row. Existing data must keep working with zero manual fixup. Add the FK
  `notNull` only *after* backfill.

## Non-negotiables (enforce)
- **Minimal-code (Ponytail):** extend, don't rebuild. No new abstractions beyond `clients.ts` +
  the `ClientContext` type. Shortest working diff. Mark every deferred seam (`token from env`,
  `durable queue`, `encrypted store`) with a `ponytail:` comment naming WS-2/WS-3.
- **Default-deny preserved:** no new code path from "proposed" to "Meta write" that bypasses
  `evaluate` → `preflightAction`. Fail closed on any client whose account budget can't be read.
- **Observe→graduate:** new clients are created with `writeMode='observe'`, `emergencyStop=true`.
  Graduation to `tier_a`/`all` is a deliberate per-client setting change, never a default.
- **UI-first:** if the dashboard/queue/settings can't pick the active client, add a minimal
  client switcher — but no broader UI work.

## Phase gates (pause for "continue" after each)
- **G1 — schema:** migration `0007_*` written, backfill verified on a copy of the dev DB
  (existing rows all get the bootstrap `client_id`; control migrated). Summarize the diff.
- **G2 — context threading:** `clients.ts` + per-client control + `buildGuardrailContext` +
  Meta client context param done. `grep -rn "process.env.META_" src/` returns hits ONLY in
  `src/lib/clients.ts`. Summarize.
- **G3 — query scoping:** every operational query and API route filters by `clientId`.
  Provide the grep evidence: no `db.select().from(adActions|creatives|ads|leads|...)` without a
  `client_id` predicate (outside agency-wide audit reads). Summarize.
- **G4 — tests:** extend `guardrails.test.ts`, `optimizer.test.ts`, `metrics.test.ts` to assert
  **per-client isolation**, plus one new 2-client integration test: client B's kill switch /
  spend cap / proposals never affect client A. All green.

## Acceptance (M1 complete)
- Two clients managed in full isolation; per-client write-mode + per-client kill + agency master
  kill all work; existing single account runs unchanged as the bootstrapped client; full test
  suite green with the new isolation tests; grep gates G2/G3 clean.
- Hand back a short report: files changed, the `0007_*` migration, grep evidence, test results,
  and the explicit list of WS-2/WS-3 seams left (token-from-env, in-process mutex, no encrypted
  store) so the next milestone picks them up.

## Anchor files
`src/db/schema.ts` · `src/lib/automation.ts` (control + executor) · `src/lib/guardrails.ts`
(pure — context only) · `src/lib/meta/client.ts` (meta-api-integrator) · `src/lib/optimizer.ts`
· `src/lib/scheduler.ts` · `src/lib/metrics.ts` · `src/app/api/**` · new `src/lib/clients.ts` ·
new `drizzle/0007_*.sql`. Spec: `docs/AGENCY_BUILD_SPEC.md` §2 WS-1, §7 M1.
