# M2 — Credentials Store & Client Onboarding · build-orchestrator task prompt

> Paste this to the **build-orchestrator** agent. It is the executable brief for milestone
> **M2** of `docs/AGENCY_BUILD_SPEC.md` (WS-2). **Depends on M1 being merged** (the `clients`
> table, `ClientContext`, `src/lib/clients.ts`, and the contextized Meta client must exist).
> Do **only** M2. WS-3 (hosting/durable queue/auth), WS-4 (pipeline wiring), WS-5 (compliance)
> are out of scope — leave clean seams, don't build them.

---

## Mission
Let the operator **onboard a real client account end-to-end** and have the engine manage it in
`observe` mode. Replace the single-account `.env` credential model with proper credential
resolution + an onboarding flow that **proves live access before a client goes active**.

**Done = the spec's M2 gate:** add a real client through the UI → `verifyAccess` round-trip
passes → scheduler polls that client's insights → dashboard shows live data — all with **zero
writes** (client created in `observe`, kill switch engaged).

---

## ⚠️ Design decision — confirm before G1 (credential model)
M1 left a `// ponytail: token from env until WS-2` seam. M2 must resolve *which* model:

- **Model A — single agency System User token (RECOMMENDED, build this).** One agency token
  manages many client ad accounts that clients have **assigned to your Business Manager**.
  Per-client you store only `metaAccountId`/`pageId`/`pixelId` (already in `clients` from M1).
  This matches how Meta agency access actually works and matches §6 of the build spec
  (Advanced Access = manage accounts you don't own *via asset grants*, not client-supplied
  tokens). Med-spa clients will never create their own System User token. **Token stays a host
  secret (env now → secret manager in WS-3), encrypted-at-rest not required for one token.**
- **Model B — per-client encrypted token.** Each client supplies their own token, stored
  AES-256-GCM-encrypted per client. Only needed if you white-label/resell so clients keep
  their own credentials. Heavier; defer unless explicitly chosen.

**Proceed with Model A.** Implement the Model-B encryption module **only** if the operator
overrides this decision — §"Model B appendix" below has the design so the seam stays open.

---

## Routing (delegate; don't re-derive)
- **Onboarding/credential API, validation, secret hygiene:** `backend` skill.
- **`verifyAccess` / token resolution signatures in `src/lib/meta/client.ts`:** delegate to
  **meta-api-integrator**. Do not edit Meta API code yourself.
- **Onboarding UI page + reuse of the M1 client switcher:** `frontend` / `vercel:shadcn`.
- **Any new table/migration:** `database` skill (next migration `0008_*`).

## Concrete subtasks (Model A)

### 1. Credential resolution (retire the per-client env token seam)
- In `src/lib/clients.ts`, add `agencyToken()` — the single source for the agency System User
  token (`process.env.META_SYSTEM_USER_TOKEN` now, `// ponytail: host secret manager in WS-3`).
  `clientContext(id)` resolves `{ accountId, pageId, pixelId }` from the `clients` **row** and
  `token` from `agencyToken()`. Remove M1's `token-from-env-per-client` ponytail marker.
- **`agencyToken()` is now the ONLY reader of `META_SYSTEM_USER_TOKEN` in the codebase.** Grep
  must confirm zero other references.

### 2. Onboarding flow — create → verify → activate
- **Status lifecycle on `clients`:** add a `verifyState text` (or reuse `status`):
  `draft → verifying → active | failed`. A client may only reach `active` after a successful
  live `verifyAccess`. New clients are created `status='active'`-blocked until verified, in
  **`writeMode='observe'` with `emergencyStop=true`** (per-client control row from M1).
- **API** `POST /api/clients` (create: name + metaAccountId + pageId + pixelId) and
  `POST /api/clients/[id]/verify` → calls `verifyAccess(clientContext(id))` (live `GET act_<id>`
  round-trip). On success: flip to `active`, write an `audit_events` row. On failure: status
  `failed`, surface Meta's verbatim error to the UI, **do not activate**. Also verify Page/Pixel
  presence if provided (the launch + CAPI paths need them).
- `GET /api/clients` returns the roster **with the token redacted/absent** (see §4).
- Reuse M1's `listActiveClients()` so the scheduler/optimizer only ever loop **verified-active**
  clients — an unverified client must never be polled or written to.

### 3. Onboarding UI
- One **Add Client** page/panel: form (name, ad account id, page id, pixel id) → "Verify access"
  button → shows the live verify result (green check or the Meta error). On success the client
  appears in the M1 client switcher. No other new screens.
- Show each client's `writeMode` + verify state in the switcher so the operator can see it's in
  `observe` before graduating it (graduation itself is the existing per-client control setting).

### 4. Retire the single-account `.env` Meta path + secret hygiene
- `api/settings/env` + `env-file.ts` + the meta-keys-form must **stop being the source of
  per-account Meta IDs** (`META_AD_ACCOUNT_ID`/`META_PAGE_ID`/`META_PIXEL_ID`) — those now live
  in `clients`. Keep env writing only for true agency/infra secrets (agency token, `DATABASE_URL`,
  AI/blob keys). Deprecate or remove the per-account fields from that form.
- **Secret hygiene (hard requirements, add tests):** the agency token is never logged, never in
  a URL/query string (client.ts already uses the `Authorization` header — verify it still does
  after M1), never returned by any API response, never written to `audit_events`. Add a redaction
  test on `GET /api/clients` and a grep gate for `META_SYSTEM_USER_TOKEN` usage.

### 5. Dev/verification accommodation
- Meta Advanced Access (M0/§6) may still be pending. **In dev, verify against the operator's own
  ad account** (Standard Access works for own accounts) — onboard the bootstrapped M1 client as
  the first real verified client. Document that managing *clients you don't own* needs Advanced
  Access granted + the client's asset-grant to your Business.

## Non-negotiables (enforce)
- **Minimal-code (Ponytail):** Model A adds no encryption/KMS machinery. New code is
  `agencyToken()` + onboarding API + one UI page. Mark the host-secret seam `// ponytail: WS-3`.
- **No client is live until verified.** Unverified/failed clients are never polled, never
  written to, never optimized.
- **Observe→graduate preserved:** onboarding always lands a client in `observe` + kill engaged.
- **Default-deny preserved:** M2 adds no new write path to Meta. `verifyAccess` is read-only.
- **UI-first:** onboarding is operable entirely from the web UI.

## Phase gates (pause for "continue" after each)
- **G1 — credential resolution:** `agencyToken()` + `clientContext` token wiring done;
  `grep -rn "META_SYSTEM_USER_TOKEN" src/` returns hits ONLY in `src/lib/clients.ts`. Summarize.
- **G2 — onboarding API:** create + verify + activate endpoints; verified-only gating in
  `listActiveClients`; failure path returns Meta's error without activating. Unit/integration
  tests for the verify gate (success activates, failure does not). Summarize.
- **G3 — onboarding UI:** operator can add a client, click Verify, and see success/failure; the
  switcher shows verify state + `writeMode`. Summarize.
- **G4 — retire `.env` path + secret hygiene:** per-account Meta fields removed from
  `api/settings/env`; redaction test on `GET /api/clients` green; grep evidence the token never
  appears in logs/URLs/responses/audit. Summarize.

## Acceptance (M2 complete)
- A real client is onboarded end-to-end via the UI, `verifyAccess` passes, it lands in `observe`,
  the scheduler polls **its** insights, and the dashboard shows live data — **zero writes**.
- Token resolves only through `agencyToken()`; never leaks. Full test suite green incl. the new
  verify-gate + redaction tests.
- Hand back a short report: files changed, the `0008_*` migration (if any), grep evidence, test
  results, and the explicit WS-3 seams left (host-secret token, no durable queue, minimal/no auth).

## Model B appendix (build ONLY if the operator overrides the decision)
If per-client tokens are chosen: add `src/lib/crypto.ts` (AES-256-GCM, 96-bit IV, key from
`CREDENTIALS_ENC_KEY` — fail closed if unset/wrong length); a `client_credentials` table
`{ clientId uuid pk fk, tokenCiphertext bytea, iv bytea, tag bytea, updatedAt }`; encrypt on
write, decrypt only inside `clientContext`; never select ciphertext into any API response; add a
round-trip encrypt/decrypt test and a key-rotation note. Everything else in M2 is identical.

## Anchor files
`src/lib/clients.ts` (M1) · `src/lib/meta/client.ts` (`verifyAccess`, token — meta-api-integrator)
· `src/lib/scheduler.ts` / `src/lib/automation.ts` (verified-only looping) · `src/db/schema.ts`
(`clients` status/verify columns) · `src/app/api/settings/env/route.ts` + `src/lib/env-file.ts`
(retire per-account Meta fields) · `src/app/api/connection/{verify,status}/route.ts` (reuse
patterns) · new `src/app/api/clients/**` + onboarding page. Spec: `docs/AGENCY_BUILD_SPEC.md`
§2 WS-2, §6 (App Review), §7 M2.
