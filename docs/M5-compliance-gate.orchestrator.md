# M5 — Compliance Gate (WS-5) · build-orchestrator task prompt

> Executable brief for milestone **M5** of `docs/AGENCY_BUILD_SPEC.md` (WS-5, §5). **Depends on
> M1–M4** (all merged to `main`). Build M5 **against the code that actually landed**, not the spec
> prose — read the anchor files first. Do **only** M5.

---

## Read first — the real state M5 builds on
The decision + persistence + audit primitive already exists; M5 slots a second, PASS-defaulting
check alongside the guardrail decision and lets a `block` override the status. Respect the seams:
- **`src/lib/automation.ts`** — `proposeAction(input)` is the single ingestion point: build
  per-client guardrail context → `evaluate` → map decision to `status` → persist the `ad_actions`
  row → `audit(...)` → auto-`dispatch` only when `approved`. `prepare()` is shared by
  `previewAction` + `proposeAction`. **The gate composes here — no second write path, no new route.**
- **`src/lib/guardrails.ts`** — the module to imitate: **pure, synchronous, versioned**, typed
  result. Compliance mirrors its shape but **defaults to PASS** (only a positive match gates),
  where guardrails default-deny.
- **`src/db/schema.ts`** — `ad_actions` already carries `evidence` + `guardrailResult` jsonb and
  `policyVersion`; `automation_control` carries `activePolicyVersion`. M5 adds the compliance
  analogues as first-class columns (so the queue can filter and the version is auditable).
- **`src/lib/client-isolation.test.ts`** — the pglite harness (runs all `drizzle/*.sql`, mocks
  `@/db` + `@/lib/meta/client`) reused by the M5 integration test.
- **`AuditService/PROCESS.html` L411/L476** — the med-spa policy phrasing the ruleset traces to:
  "med spa ads can't imply personal health attributes or use 'you/your body' before-after framing;
  reword to general benefit"; speed-to-lead "call within 5 min + reminder text" (TCPA).

## Mission
Add the last safety layer before a live client: a **synchronous PASS/FLAG/BLOCK chokepoint** inside
`proposeAction` that inspects a proposal's **creative copy + targeting** against a versioned med-spa
health-ad ruleset *before* it can reach approval. **Done =** a non-compliant creative/targeting
change is persisted `blocked` (never dispatched) with an immutable audit of the ruleset version;
a compliant proposal behaves exactly as pre-M5.

## Decisions already locked (do not re-litigate)
- **Storage = migration.** `ad_actions` += `compliance_status` (text default `'pass'`) +
  `compliance_findings` (jsonb); `automation_control` += `active_compliance_version` (int default 1).
- **FLAG = annotate only.** PASS/FLAG → the normal guardrail decision stands; only **BLOCK** forces
  status `blocked`. Single-operator agency; no second-reviewer routing.
- **Per-client exclusion list = deferred (ponytail).** Federal/Meta med-spa ruleset only; the
  `evaluateCompliance(…, extraBlockTerms?)` seam is left for a later per-client self-ban column.
- Med-spa content only. **No mortgage/ECOA/RESPA/Credit logic.**

## Routing (delegate; don't re-derive)
- Rule module + automation wiring: **backend**.
- Schema columns + migration `0011`: **database**.
- **No meta-api-integrator** (no `client.ts` change), **no new endpoint** (`/api/actions` returns
  the persisted row, which now carries the compliance fields).

## Concrete subtasks
1. **`src/lib/compliance.ts`** — new pure, versioned module. `COMPLIANCE_VERSION = 1`;
   `ComplianceStatus`; `Reviewable { copy; targeting }`; `ComplianceFinding`; `evaluateCompliance(r,
   extraBlockTerms?) → { status, version, findings[] }` returning the strongest severity
   (`block` > `flag` > `pass`). Ruleset: **BLOCK** personal "you/your body" before-after creative +
   personal-health-attribute targeting; **FLAG** unsubstantiated results claims (no FTC disclaimer)
   + TCPA contact-without-consent. Defaults to PASS.
2. **`src/db/schema.ts` + `drizzle/0011_*.sql`** — the three columns above; `npm run db:generate`
   then `npm run db:migrate`.
3. **`src/lib/automation.ts`** — `buildReviewable(input)` (copy = string leaves of `targetState` +
   `evidence.auditFinding`/`rationale`; targeting = `targetState` for `change_targeting`/
   `expand_audience`, else `{}`); compute compliance in `prepare()`; `status =
   compliance.status==='block' ? 'blocked' : <existing guardrail mapping>`; persist both columns;
   audit `action.compliance_evaluated` `{status, version, findings}`; surface compliance in
   `previewAction()`.
4. **`src/lib/compliance.test.ts`** — hermetic unit tests (guardrails.test.ts style) + a pglite
   integration test (client-isolation harness) proving a non-compliant proposal persists
   `status='blocked'`/`compliance_status='block'`, audits the version, is not dispatched, and never
   touches another client's rows.

## Phase gates
- **G1 (unit):** `compliance.test.ts` pure cases green — before-after creative → block, reworded →
  pass, health-attribute targeting → block, results claim → flag, version stamped.
- **G2 (integration + regression):** full `vitest` suite green (guardrails/optimizer/metrics/M4
  import + client-isolation unchanged); `eslint` + `tsc -p` clean on M5 files; the pglite
  integration test proves the blocked-not-dispatched path and cross-client isolation.

## Acceptance (spec §7 M5)
A non-compliant creative/targeting change is BLOCKed before approval and audit-logged with the
ruleset version; a compliant proposal's status + dispatch are unchanged from pre-M5.

## Anchor files
- New: `src/lib/compliance.ts`, `src/lib/compliance.test.ts`, `drizzle/0011_goofy_rhino.sql`
  (generated), `docs/M5-compliance-gate.orchestrator.md` (this file).
- Edit: `src/lib/automation.ts` (`buildReviewable` + `prepare`/`proposeAction`/`previewAction`),
  `src/db/schema.ts` (2 cols on `ad_actions`, 1 on `automation_control`).
- Read/anchor: `src/lib/guardrails.ts`, `src/app/api/actions/route.ts` (unchanged),
  `src/lib/client-isolation.test.ts`, `AuditService/PROCESS.html` L411/L476, spec §5.

skipped: per-client exclusion list (add when first client needs a self-ban), DB-backed rules table
+ AI pre-filter (add at 2nd vertical), FLAG→second-reviewer routing (single operator),
compliance-reason UI in the queue (data is on the row; render when the queue view needs it).
