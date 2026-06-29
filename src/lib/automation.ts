// Autonomy service layer — docs/ARCHITECTURE.md §5. DB-backed propose → guardrail →
// (Tier A ready | Tier B pending_approval | blocked) → approve/reject → dispatch to the
// executor (Inngest). Every state change is audited. This module never writes to Meta.
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "@/db";
import { automationControl, agencyControl, adActions, actionAttempts, auditEvents, metricFetches, ads, creatives } from "@/db/schema";
import { clientContext, getClient, type ClientContext } from "@/lib/clients";
import {
  evaluate, tierOf, ACTION_TYPES, type ActionType, type ProposedAction, type GuardrailContext,
} from "./guardrails";
import {
  applyAbsolutePatch, findByLaunchToken, createAdCreative, createAdObject, getDailyBudgetCents,
  fetchEnabledBudgets, fetchChildAdsetBudgets, getBudgetInfo,
  type AbsolutePatch, type ApplyResult,
} from "@/lib/meta/client";

// Parse the env write-mode against a strict whitelist — a typo ("tier-a", "observe ") must NOT
// fail open. Anything unrecognized → "off".
const WRITE_MODES = ["off", "observe", "tier_a", "all"] as const;
function parseWriteMode(v: string | undefined): GuardrailContext["envWriteMode"] {
  const t = (v ?? "").trim();
  return (WRITE_MODES as readonly string[]).includes(t) ? (t as GuardrailContext["envWriteMode"]) : "off";
}
const ENV_WRITE_MODE = parseWriteMode(process.env.WRITE_MODE);

export async function getControl(clientId: string) {
  const rows = await getDb().select().from(automationControl)
    .where(eq(automationControl.clientId, clientId)).limit(1);
  return rows[0] ?? null;
}

/** Ensure this client's control row exists. observe→graduate defaults: kill engaged, write_mode off. */
export async function ensureControl(clientId: string) {
  const existing = await getControl(clientId);
  if (existing) return existing;
  await getDb().insert(automationControl)
    .values({ clientId, writeMode: "off", emergencyStop: true })
    .onConflictDoNothing({ target: automationControl.clientId });
  return (await getControl(clientId))!;
}

// ── Agency master gate (singleton, layered ABOVE every per-client control) ──────────
export async function getAgencyControl() {
  const [row] = await getDb().select().from(agencyControl).limit(1);
  return row ?? null;
}

/** Ensure the agency master row exists. Per-client gates enforce default-deny for new clients. */
export async function ensureAgencyControl() {
  const existing = await getAgencyControl();
  if (existing) return existing;
  await getDb().insert(agencyControl).values({ id: true, emergencyStop: false }).onConflictDoNothing();
  return (await getAgencyControl())!;
}

export async function setAgencyControl(patch: { emergencyStop?: boolean }, actor = "operator") {
  await ensureAgencyControl();
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.emergencyStop !== undefined) values.emergencyStop = patch.emergencyStop;
  const [row] = await getDb().update(agencyControl).set(values).where(eq(agencyControl.id, true)).returning();
  await audit(null, actor, "agency.control.updated", null, JSON.stringify(patch));
  return row;
}

/** Agency-wide kill: halts writes for EVERY client at once. */
export async function engageAgencyKill(actor = "operator") {
  return setAgencyControl({ emergencyStop: true }, actor);
}

// Per-client freshness signal: the most recent insights fetch for THIS client's ad account
// (ingestInsights stamps metric_fetches.request = { accountId }). No schema change needed.
async function metricsFresh(accountId: string, minMinutes: number): Promise<boolean> {
  const [row] = await getDb()
    .select({ fetchedAt: metricFetches.fetchedAt })
    .from(metricFetches)
    .where(sql`${metricFetches.request}->>'accountId' = ${accountId}`)
    .orderBy(desc(metricFetches.fetchedAt))
    .limit(1);
  if (!row?.fetchedAt) return false; // no data → not fresh → blocks spend increases (safe)
  return Date.now() - new Date(row.fetchedAt).getTime() <= minMinutes * 60_000;
}

const UNRESOLVED_STATUSES = ["executing", "uncertain"] as const;

/** True if any write FOR THIS CLIENT is in-flight or uncertain. Gates new spend-increasing
 *  proposals (fail closed). `excludeId` skips the action currently executing so preflight doesn't
 *  deadlock on itself. Scoped by clientId so one client's stuck write never blocks another's. */
async function hasUnresolvedWrites(clientId: string, excludeId?: string): Promise<boolean> {
  const where = excludeId
    ? sql`${adActions.clientId} = ${clientId} and ${adActions.status} in ('executing','uncertain') and ${adActions.id} <> ${excludeId}`
    : sql`${adActions.clientId} = ${clientId} and ${adActions.status} in ('executing','uncertain')`;
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(adActions).where(where);
  return (row?.n ?? 0) > 0;
}

async function audit(
  clientId: string | null, actor: string, eventType: string, subjectId: string | null,
  after: unknown = null, reason: string | null = null,
) {
  await getDb().insert(auditEvents).values({
    clientId, actor, eventType, subjectId, after, reason,
    actionId: subjectId,
  });
}

/** Per-client guardrail context: this client's control row, metric freshness, unresolved-write
 *  flag, with effective kill = agency.emergencyStop OR client.emergencyStop. The pure evaluate()
 *  is untouched — only its context source is per-client now. */
export async function buildGuardrailContext(
  clientId: string,
  opts: { projectedDailySpendCents?: number; excludeActionId?: string } = {},
) {
  const client = await getClient(clientId);
  if (!client) throw new Error(`unknown client: ${clientId}`);
  const control = await ensureControl(clientId);
  const agency = await ensureAgencyControl();
  const fresh = await metricsFresh(client.metaAccountId, control.minMetricFreshnessMinutes);
  const unresolved = await hasUnresolvedWrites(clientId, opts.excludeActionId);
  const ctx: GuardrailContext = {
    envWriteMode: ENV_WRITE_MODE,
    control: {
      writeMode: control.writeMode as GuardrailContext["control"]["writeMode"],
      emergencyStop: agency.emergencyStop || control.emergencyStop, // effective kill = agency OR client
      maxAccountDailySpendCents: control.maxAccountDailySpendCents,
      maxActionBudgetDeltaCents: control.maxActionBudgetDeltaCents,
      maxActionBudgetDeltaPct: Number(control.maxActionBudgetDeltaPct),
      activePolicyVersion: control.activePolicyVersion,
    },
    metricsFresh: fresh,
    unresolvedWrites: unresolved,
    projectedDailySpendCents: opts.projectedDailySpendCents ?? 0,
  };
  return { control, ctx };
}

async function dispatch(actionId: string) {
  await getDb().update(adActions).set({ status: "executing" }).where(eq(adActions.id, actionId));
  await executeAdAction(actionId); // inline executor (desktop build; no durable queue)
}

export interface ProposeInput {
  clientId: string;
  actionType: ActionType;
  entityType: string;
  entityId: string;
  targetState: Record<string, unknown>; // absolute target, never a delta
  dailyBudgetDeltaCents?: number;
  dailyBudgetDeltaPct?: number;
  projectedDailySpendCents?: number;
  evidence?: unknown;
  actor?: string;
  idempotencyKey?: string; // deterministic key dedupes repeat proposals (e.g. from the optimizer)
}

// Trust-boundary validation for the propose/preview API routes. Deltas are signed (decreases
// are negative); projection is non-negative. Unknown keys rejected.
export const ProposeInputSchema = z
  .object({
    clientId: z.string().uuid(),
    actionType: z.enum(ACTION_TYPES),
    entityType: z.enum(["account", "campaign", "adset", "ad"]),
    entityId: z.string().min(1).max(256),
    targetState: z.record(z.string(), z.unknown()),
    dailyBudgetDeltaCents: z.number().int().optional(),
    dailyBudgetDeltaPct: z.number().optional(),
    projectedDailySpendCents: z.number().int().min(0).optional(),
    evidence: z.unknown().optional(),
    actor: z.string().max(64).optional(),
    idempotencyKey: z.string().max(256).optional(),
  })
  .strict();

/** Shared: load this client's control + freshness, build context, run guardrails. No DB writes. */
async function prepare(input: ProposeInput) {
  const { control, ctx } = await buildGuardrailContext(input.clientId, {
    projectedDailySpendCents: input.projectedDailySpendCents ?? 0,
  });
  const action: ProposedAction = {
    actionType: input.actionType,
    policyVersion: control.activePolicyVersion,
    dailyBudgetDeltaCents: input.dailyBudgetDeltaCents ?? 0,
    dailyBudgetDeltaPct: input.dailyBudgetDeltaPct ?? 0,
  };
  return { control, result: evaluate(action, ctx) };
}

/** Preview the guardrail decision without persisting — drives the editor preview. */
export async function previewAction(input: ProposeInput) {
  const { result } = await prepare(input);
  return { result, tier: tierOf(input.actionType) };
}

/** Propose an action: evaluate guardrails, persist, audit, and auto-dispatch if allowed. */
export async function proposeAction(input: ProposeInput) {
  const { control, result } = await prepare(input);
  const status =
    result.decision === "allow" ? "approved"            // Tier A within caps → ready
    : result.decision === "require_approval" ? "pending_approval"
    : "blocked";

  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  const [row] = await getDb().insert(adActions).values({
    clientId: input.clientId,
    tier: tierOf(input.actionType),
    status,
    actionType: input.actionType,
    entityType: input.entityType,
    entityId: input.entityId,
    targetState: input.targetState,
    dailyBudgetDeltaCents: input.dailyBudgetDeltaCents ?? 0,
    dailyBudgetDeltaPct: String(input.dailyBudgetDeltaPct ?? 0),
    projectedDailySpendCents: input.projectedDailySpendCents ?? 0,
    evidence: input.evidence ?? null,
    guardrailResult: result,
    policyVersion: control.activePolicyVersion,
    idempotencyKey,
    expiresAt: new Date(Date.now() + 24 * 3600_000),
  }).onConflictDoNothing({ target: adActions.idempotencyKey }).returning();

  if (!row) {
    // Duplicate (same deterministic key) — return the existing proposal, no re-dispatch.
    const [existing] = await getDb().select().from(adActions)
      .where(eq(adActions.idempotencyKey, idempotencyKey)).limit(1);
    return existing;
  }

  await audit(input.clientId, input.actor ?? "system", "action.proposed", row.id, { status, result });
  if (status === "approved") await dispatch(row.id);
  return row;
}

export async function listQueue(clientId: string) {
  return getDb().select().from(adActions)
    .where(and(eq(adActions.clientId, clientId), eq(adActions.status, "pending_approval")))
    .orderBy(desc(adActions.createdAt));
}

/** In-flight or post-crash writes awaiting reconciliation. Drives the unresolved-writes UI. */
export async function listUnresolved(clientId: string) {
  return getDb().select().from(adActions)
    .where(and(eq(adActions.clientId, clientId), inArray(adActions.status, UNRESOLVED_STATUSES as unknown as string[])))
    .orderBy(desc(adActions.createdAt));
}

/** Operator resolves an `uncertain` action after checking remote state in Meta. Records an attempt
 *  + terminal status + audit. (Auto-reconciliation against live reads will replace this — see §5.) */
export async function resolveUncertain(id: string, applied: boolean, actor = "operator") {
  const db = getDb();
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` }).from(actionAttempts).where(eq(actionAttempts.actionId, id));
  await db.insert(actionAttempts).values({ actionId: id, attempt: count + 1, error: applied ? null : "operator: not applied" });
  const status = applied ? "succeeded" : "failed";
  const [row] = await db.update(adActions).set({ status }).where(eq(adActions.id, id)).returning();
  if (row) await audit(row.clientId, actor, `action.${status}`, id, null, "operator-resolved uncertain write");
  return row;
}

/** Approve a Tier B action: only a still-pending, unexpired action may be approved (never a
 *  blocked/failed/succeeded/uncertain one). The full guardrail re-check happens at executor
 *  preflight, then dispatch. The status-conditional UPDATE makes the transition atomic. */
export async function approveAction(id: string, actor = "operator") {
  const db = getDb();
  const [action] = await db.select().from(adActions).where(eq(adActions.id, id)).limit(1);
  if (!action) throw new Error("action not found");
  if (action.status !== "pending_approval") throw new Error(`cannot approve action in status '${action.status}'`);
  if (new Date(action.expiresAt) < new Date()) throw new Error("action expired");
  const [row] = await db.update(adActions)
    .set({ status: "approved" })
    .where(and(eq(adActions.id, id), eq(adActions.status, "pending_approval")))
    .returning();
  if (!row) throw new Error("action no longer pending approval");
  await audit(action.clientId, actor, "action.approved", id);
  await dispatch(id);
  return row;
}

export async function rejectAction(id: string, actor = "operator") {
  const [row] = await getDb().update(adActions)
    .set({ status: "rejected" }).where(eq(adActions.id, id)).returning();
  if (row) await audit(row.clientId, actor, "action.rejected", id);
  return row;
}

/** Per-client kill switch: halt THIS client's writes immediately. */
export async function engageKill(clientId: string, actor = "operator") {
  await ensureControl(clientId);
  const [row] = await getDb().update(automationControl)
    .set({ emergencyStop: true, writeMode: "off", updatedAt: new Date(), updatedBy: actor })
    .where(eq(automationControl.clientId, clientId)).returning();
  await audit(clientId, actor, "kill_switch.engaged", null);
  return row;
}

export interface ControlPatch {
  writeMode?: "off" | "observe" | "tier_a" | "all";
  emergencyStop?: boolean;
  maxAccountDailySpendCents?: number;
  maxActionBudgetDeltaCents?: number;
  maxActionBudgetDeltaPct?: number;
  minMetricFreshnessMinutes?: number;
  targetCpaCents?: number;
  targetRoas?: number;
}

export async function setControl(clientId: string, patch: ControlPatch, actor = "operator") {
  await ensureControl(clientId);
  const values: Record<string, unknown> = { updatedAt: new Date(), updatedBy: actor };
  if (patch.writeMode !== undefined) values.writeMode = patch.writeMode;
  if (patch.emergencyStop !== undefined) values.emergencyStop = patch.emergencyStop;
  if (patch.maxAccountDailySpendCents !== undefined) values.maxAccountDailySpendCents = patch.maxAccountDailySpendCents;
  if (patch.maxActionBudgetDeltaCents !== undefined) values.maxActionBudgetDeltaCents = patch.maxActionBudgetDeltaCents;
  if (patch.maxActionBudgetDeltaPct !== undefined) values.maxActionBudgetDeltaPct = String(patch.maxActionBudgetDeltaPct);
  if (patch.minMetricFreshnessMinutes !== undefined) values.minMetricFreshnessMinutes = patch.minMetricFreshnessMinutes;
  if (patch.targetCpaCents !== undefined) values.targetCpaCents = patch.targetCpaCents;
  if (patch.targetRoas !== undefined) values.targetRoas = String(patch.targetRoas);

  const [row] = await getDb().update(automationControl)
    .set(values).where(eq(automationControl.clientId, clientId)).returning();
  await audit(clientId, actor, "control.updated", null, JSON.stringify(patch));
  return row;
}

/** Audit feed. Per-client when `clientId` is given; with no clientId this is the INTENTIONAL
 *  agency-wide read (all clients) for the agency audit/export view. */
export async function listAudit(clientId?: string, limit = 50) {
  const q = getDb().select().from(auditEvents);
  const rows = clientId
    ? q.where(eq(auditEvents.clientId, clientId))
    : q; // agency-wide audit read (deliberate cross-client)
  return rows.orderBy(desc(auditEvents.createdAt)).limit(limit);
}

// ── Executor — the ONLY path that writes to Meta ───────────────────────────────────

/** preflight re-check → apply absolute patch → reconcile. Runs inline (single-instance
 *  desktop build, no durable queue). Records every outcome; never rethrows to the caller —
 *  the Meta client retries transient errors internally, and the next poll reconciles
 *  anything left uncertain. ponytail: inline executor; add a durable queue if multi-instance. */
// Serialize executor writes PER CLIENT so only one Meta write per client runs at a time, while
// different clients run concurrently. This closes the TOCTOU where two concurrent dispatches for
// the same client both pass the unresolved-writes gate before either flips to `executing`
// (double-click, scheduler + UI, retries). ponytail: in-process per-client mutex; durable queue +
// Postgres advisory locks (held across preflight + the Meta write) for multi-instance = WS-3.
const writeChains = new Map<string, Promise<unknown>>();
function serializeWrite<T>(clientId: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(clientId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  writeChains.set(clientId, run.then(() => {}, () => {}));
  return run;
}

export async function executeAdAction(actionId: string) {
  const [action] = await getDb()
    .select({ clientId: adActions.clientId }).from(adActions).where(eq(adActions.id, actionId)).limit(1);
  if (!action) return { status: "failed" as const, error: "execute: action not found" };
  const ctx = await clientContext(action.clientId);
  return serializeWrite(action.clientId, () => runExecute(actionId, ctx));
}

async function runExecute(actionId: string, ctx: ClientContext) {
  const pre = await preflightAction(actionId, ctx);
  if (!pre.allowed || (!pre.metaPayload && !pre.launch)) {
    return reconcileAction(actionId, { ok: false, error: `preflight: ${pre.reason}` });
  }
  let applied: ApplyResult;
  try {
    applied = pre.launch ? await runLaunch(actionId, ctx) : await applyAbsolutePatch(ctx, pre.metaPayload!);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markUncertain(actionId, msg);
    return { status: "uncertain" as const, error: msg };
  }
  return reconcileAction(actionId, { ok: applied.ok, metaResponse: applied.metaResponse });
}

/**
 * Launch saga (create AdCreative + Ad). CREATE is not idempotent like an absolute patch, so:
 *  - phases are durable via existing columns (creatives.metaCreativeId, ads.metaAdId) — a retry
 *    never recreates a phase whose id is already saved;
 *  - before creating, we reconcile by the deterministic launch token embedded in the object name
 *    (findByLaunchToken): adopt a match a crashed retry already created; >1 match = fail closed;
 *  - the ad is created PAUSED — nothing spends until a separate Tier B unpause.
 * The unresolved-writes gate blocks other writes while this action is executing/uncertain.
 */
async function runLaunch(actionId: string, ctx: ClientContext): Promise<ApplyResult> {
  const db = getDb();
  const [action] = await db.select().from(adActions).where(eq(adActions.id, actionId)).limit(1);
  const [ad] = await db.select().from(ads).where(eq(ads.id, action.entityId)).limit(1);
  if (!ad) throw new Error("launch: ad row not found");
  if (!ad.adsetId) throw new Error("launch: ad has no adsetId — supply an existing Meta adset");
  if (!ad.destinationUrl) throw new Error("launch: destinationUrl required");
  if (!ad.creativeId) throw new Error("launch: ad has no creative");
  const [creative] = await db.select().from(creatives).where(eq(creatives.id, ad.creativeId)).limit(1);
  if (!creative) throw new Error("launch: creative not found");

  const pageId = ctx.pageId;
  if (!pageId) throw new Error("launch: client has no pageId configured");
  const token = action.idempotencyKey;
  const tagged = `${ad.id} [launch:${token}]`;
  const copy = (ad.copy ?? {}) as { headline?: string; primaryText?: string; description?: string };

  // Phase 1 — AdCreative (durable: creatives.metaCreativeId)
  let creativeId = creative.metaCreativeId ?? null;
  if (!creativeId) {
    const found = await findByLaunchToken(ctx, "adcreatives", token);
    if (found.length > 1) throw new Error(`launch: ambiguous (${found.length}) creatives for token — manual cleanup`);
    creativeId = found[0] ?? await createAdCreative(ctx, {
      name: tagged, pageId, imageUrl: creative.blobUrl, link: ad.destinationUrl,
      message: copy.primaryText, headline: copy.headline, description: copy.description, cta: ad.cta ?? undefined,
    });
    await db.update(creatives).set({ metaCreativeId: creativeId }).where(eq(creatives.id, creative.id));
  }

  // Phase 2 — Ad, PAUSED (durable: ads.metaAdId)
  let metaAdId = ad.metaAdId ?? null;
  if (!metaAdId) {
    const found = await findByLaunchToken(ctx, "ads", token);
    if (found.length > 1) throw new Error(`launch: ambiguous (${found.length}) ads for token — manual cleanup`);
    metaAdId = found[0] ?? await createAdObject(ctx, { name: tagged, adsetId: ad.adsetId, creativeId });
    await db.update(ads).set({ metaAdId, status: "paused" }).where(eq(ads.id, ad.id));
  }

  return { ok: true, metaResponse: { creativeId, metaAdId } };
}

export interface Preflight { allowed: boolean; reason?: string; metaPayload?: AbsolutePatch; launch?: boolean }

const PAUSE_TYPES = new Set<ActionType>(["pause_ad", "pause_adset", "pause_campaign"]);
const BUDGET_TYPES = new Set<ActionType>(["set_budget", "decrease_budget", "increase_budget"]);

/** Re-check guardrails at execution time and build the absolute write payload. This is the
 *  ONLY gate before a Meta write, so it is deliberately strict and self-contained. */
export async function preflightAction(actionId: string, ctx?: ClientContext): Promise<Preflight> {
  const db = getDb();
  const [action] = await db.select().from(adActions).where(eq(adActions.id, actionId)).limit(1);
  if (!action) return { allowed: false, reason: "not_found" };
  if (action.status !== "approved" && action.status !== "executing") return { allowed: false, reason: `status_${action.status}` };
  if (new Date(action.expiresAt) < new Date()) return { allowed: false, reason: "expired" };
  // Build the client's credential context if not supplied by the executor (e.g. direct callers/tests).
  ctx = ctx ?? (await clientContext(action.clientId));

  const actionType = action.actionType as ActionType;
  const target = (action.targetState ?? {}) as Record<string, unknown>;

  // ── Semantic validation: the payload must match what the action TYPE claims. Otherwise a
  // spend-reducing classification (which skips stale/cap gates) could carry a spend-INCREASING
  // payload (e.g. pause_campaign with {status:"ACTIVE"}). Budget deltas are computed SERVER-side
  // from live Meta state so the caps never depend on caller-supplied numbers.
  let deltaCents = 0;
  let deltaPct = 0;
  if (PAUSE_TYPES.has(actionType)) {
    if (String(target.status ?? "").toUpperCase() !== "PAUSED") return { allowed: false, reason: "semantic_pause_requires_PAUSED" };
  } else if (actionType === "unpause") {
    if (String(target.status ?? "").toUpperCase() !== "ACTIVE") return { allowed: false, reason: "semantic_unpause_requires_ACTIVE" };
  } else if (BUDGET_TYPES.has(actionType)) {
    if (!Number.isInteger(target.daily_budget)) return { allowed: false, reason: "budget_target_not_absolute_integer" };
    const next = target.daily_budget as number;
    if (next <= 0) return { allowed: false, reason: "budget_target_must_be_positive" };
    let current: number | null = null;
    try { current = await getDailyBudgetCents(ctx, action.entityId); } catch { current = null; }
    if (current == null) return { allowed: false, reason: "budget_current_unknown" }; // fail closed — can't verify the delta
    deltaCents = next - current;
    deltaPct = current > 0 ? (deltaCents / current) * 100 : 100;
    if (actionType === "decrease_budget" && deltaCents >= 0) return { allowed: false, reason: "decrease_must_lower_budget" };
    if (actionType === "increase_budget" && deltaCents <= 0) return { allowed: false, reason: "increase_must_raise_budget" };
  }

  // Account-cap projection is computed SERVER-side (never trusts the caller/UI) as the RESULTING
  // account-wide committed daily budget: sum of every enabled entity's daily budget (CBO campaigns
  // + ABO adsets) with this action applied. That makes maxAccountDailySpendCents a true ceiling on
  // budget commitment (spend-so-far would understate it). Checked for spend-INCREASING actions:
  // a positive budget delta (its new budget) and unpause (the budget that resumes spending).
  // Reductions / non-budget actions pass 0. Fail closed if the account budget can't be read.
  let projectedDailySpendCents = 0;
  const isIncrease = BUDGET_TYPES.has(actionType) && deltaCents > 0;
  if (isIncrease || actionType === "unpause") {
    let scan: Awaited<ReturnType<typeof fetchEnabledBudgets>>;
    try { scan = await fetchEnabledBudgets(ctx); } catch { return { allowed: false, reason: "account_budget_unknown" }; }
    // Lifetime budgets have no safe daily-cap equivalent → fail closed rather than under-project.
    if (scan.hasLifetime) return { allowed: false, reason: "lifetime_budget_unsupported" };
    const sumOthers = Object.entries(scan.daily)
      .filter(([id]) => id !== action.entityId) // exclude this entity; we add its post-action budget below
      .reduce((s, [, v]) => s + v, 0);
    let addBack: number;
    if (isIncrease) {
      addBack = target.daily_budget as number; // its new budget
    } else {
      // unpause: the budget that resumes spending, derived from the LIVE object via entityId only
      // (declared entityType is NOT trusted — it can diverge from entityId, and the Meta write
      // targets entityId regardless). Ad → 0 (parent budget already in sumOthers); CBO campaign /
      // ABO adset → own daily; paused ABO campaign → its child adsets' daily, summed.
      let info: Awaited<ReturnType<typeof getBudgetInfo>>;
      try { info = await getBudgetInfo(ctx, action.entityId); } catch { return { allowed: false, reason: "account_budget_unknown" }; }
      if (!info.isBudgetNode) addBack = 0;
      else if (info.lifetimeCents != null) return { allowed: false, reason: "lifetime_budget_unsupported" };
      else if (info.dailyCents != null) addBack = info.dailyCents;
      else {
        let child: Awaited<ReturnType<typeof fetchChildAdsetBudgets>>;
        try { child = await fetchChildAdsetBudgets(ctx, action.entityId); } catch { return { allowed: false, reason: "account_budget_unknown" }; }
        if (child.hasLifetime) return { allowed: false, reason: "lifetime_budget_unsupported" };
        addBack = child.dailyCents;
      }
    }
    projectedDailySpendCents = sumOthers + addBack;
  }

  // Re-run the FULL guardrail set against CURRENT state with SERVER-computed delta + projection:
  // live control caps, metric freshness, and unresolved sibling writes (excluding this action so
  // it can't deadlock on itself). A hard `block` always fails closed. A Tier A action must
  // evaluate to `allow` to proceed — if it now needs approval (e.g. its real budget delta exceeds
  // the cap) we block rather than auto-write. Tier B `require_approval` proceeds (human approved).
  const { ctx: gctx } = await buildGuardrailContext(action.clientId, {
    projectedDailySpendCents,
    excludeActionId: action.id, // exclude self so this in-flight action can't deadlock its own gate
  });
  const result = evaluate(
    { actionType, policyVersion: action.policyVersion, dailyBudgetDeltaCents: deltaCents, dailyBudgetDeltaPct: deltaPct },
    gctx,
  );
  if (result.decision === "block") return { allowed: false, reason: result.code };
  if (result.decision === "require_approval" && tierOf(actionType) === "A") {
    return { allowed: false, reason: `needs_approval_${result.code}` }; // Tier A must be `allow` to auto-write
  }

  // Launch is a create saga (handled by runLaunch), not an absolute patch.
  if (actionType === "launch_ad") return { allowed: true, launch: true };

  // Build the EXACT payload from the action type — never copy arbitrary fields from targetState
  // (that would let e.g. decrease_budget smuggle {status:"ACTIVE"} and unpause without approval).
  let fields: Record<string, string | number | boolean>;
  if (PAUSE_TYPES.has(actionType)) fields = { status: "PAUSED" };
  else if (actionType === "unpause") fields = { status: "ACTIVE" };
  else if (BUDGET_TYPES.has(actionType)) fields = { daily_budget: target.daily_budget as number };
  else fields = {}; // not supported as an absolute patch (e.g. targeting/structural)
  if (Object.keys(fields).length === 0) return { allowed: false, reason: "no_absolute_writable_fields" };

  return {
    allowed: true,
    metaPayload: { entityType: action.entityType as AbsolutePatch["entityType"], entityId: action.entityId, fields },
  };
}

/** Record the attempt, set terminal status, and audit. */
export async function reconcileAction(
  actionId: string, outcome: { ok: boolean; metaResponse?: unknown; error?: string },
) {
  const db = getDb();
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` }).from(actionAttempts).where(eq(actionAttempts.actionId, actionId));
  await db.insert(actionAttempts).values({
    actionId, attempt: count + 1, metaResponse: outcome.metaResponse ?? null, error: outcome.error ?? null,
  });
  const status = outcome.ok ? "succeeded" : "failed";
  const [row] = await db.update(adActions).set({ status })
    .where(eq(adActions.id, actionId)).returning({ clientId: adActions.clientId });
  if (row) await audit(row.clientId, "executor", `action.${status}`, actionId, outcome.metaResponse ?? null, outcome.error ?? null);
  return { status };
}

/** Post-write timeout: don't retry blindly — mark uncertain for reconciliation. */
export async function markUncertain(actionId: string, error: string) {
  const [row] = await getDb().update(adActions).set({ status: "uncertain" })
    .where(eq(adActions.id, actionId)).returning({ clientId: adActions.clientId });
  if (row) await audit(row.clientId, "executor", "action.uncertain", actionId, null, error);
}

/**
 * Crash recovery. An action left in `executing` means the process died mid-write — the Meta
 * write may or may not have applied, so we must NOT treat it as done. Demote it to `uncertain`
 * so the guardrail gate blocks new spend-increasing writes until it is reconciled. Called once
 * at scheduler startup. ponytail: full reconciliation against live remote state (compare
 * targetState to the entity's actual Meta state) is owned by meta-api-integrator — wire it here
 * once read paths are live so uncertain actions auto-resolve instead of waiting for an operator.
 */
export async function recoverOrphanedWrites(): Promise<{ recovered: number }> {
  const rows = await getDb().update(adActions)
    .set({ status: "uncertain" })
    .where(eq(adActions.status, "executing"))
    .returning({ id: adActions.id, clientId: adActions.clientId });
  for (const r of rows) await audit(r.clientId, "executor", "action.uncertain", r.id, null, "recovered: process restart mid-write");
  if (rows.length) console.warn(`[recovery] demoted ${rows.length} orphaned executing write(s) to uncertain`);
  return { recovered: rows.length };
}
