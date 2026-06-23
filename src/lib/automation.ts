// Autonomy service layer — docs/ARCHITECTURE.md §5. DB-backed propose → guardrail →
// (Tier A ready | Tier B pending_approval | blocked) → approve/reject → dispatch to the
// executor (Inngest). Every state change is audited. This module never writes to Meta.
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "@/db";
import { automationControl, adActions, actionAttempts, auditEvents, metricFetches, ads, creatives } from "@/db/schema";
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

export async function getControl() {
  const rows = await getDb().select().from(automationControl).limit(1);
  return rows[0] ?? null;
}

/** Ensure the singleton control row exists (safe defaults: kill engaged, write_mode off). */
export async function ensureControl() {
  const existing = await getControl();
  if (existing) return existing;
  const [row] = await getDb().insert(automationControl).values({ id: true }).returning();
  return row;
}

async function metricsFresh(minMinutes: number): Promise<boolean> {
  const [row] = await getDb()
    .select({ fetchedAt: metricFetches.fetchedAt })
    .from(metricFetches)
    .orderBy(desc(metricFetches.fetchedAt))
    .limit(1);
  if (!row?.fetchedAt) return false; // no data → not fresh → blocks spend increases (safe)
  return Date.now() - new Date(row.fetchedAt).getTime() <= minMinutes * 60_000;
}

const UNRESOLVED_STATUSES = ["executing", "uncertain"] as const;

/** True if any write is in-flight or uncertain. Gates new spend-increasing proposals (fail closed).
 *  `excludeId` skips the action currently executing so preflight doesn't deadlock on itself. */
async function hasUnresolvedWrites(excludeId?: string): Promise<boolean> {
  const where = excludeId
    ? sql`${adActions.status} in ('executing','uncertain') and ${adActions.id} <> ${excludeId}`
    : inArray(adActions.status, UNRESOLVED_STATUSES as unknown as string[]);
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(adActions).where(where);
  return (row?.n ?? 0) > 0;
}

async function audit(
  actor: string, eventType: string, subjectId: string | null,
  after: unknown = null, reason: string | null = null,
) {
  await getDb().insert(auditEvents).values({
    actor, eventType, subjectId, after, reason,
    actionId: subjectId,
  });
}

async function dispatch(actionId: string) {
  await getDb().update(adActions).set({ status: "executing" }).where(eq(adActions.id, actionId));
  await executeAdAction(actionId); // inline executor (desktop build; no durable queue)
}

export interface ProposeInput {
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

/** Shared: load control + freshness, build context, run guardrails. No DB writes. */
async function prepare(input: ProposeInput) {
  const control = await ensureControl();
  const fresh = await metricsFresh(control.minMetricFreshnessMinutes);
  const unresolved = await hasUnresolvedWrites();
  const action: ProposedAction = {
    actionType: input.actionType,
    policyVersion: control.activePolicyVersion,
    dailyBudgetDeltaCents: input.dailyBudgetDeltaCents ?? 0,
    dailyBudgetDeltaPct: input.dailyBudgetDeltaPct ?? 0,
  };
  const ctx: GuardrailContext = {
    envWriteMode: ENV_WRITE_MODE,
    control: {
      writeMode: control.writeMode as GuardrailContext["control"]["writeMode"],
      emergencyStop: control.emergencyStop,
      maxAccountDailySpendCents: control.maxAccountDailySpendCents,
      maxActionBudgetDeltaCents: control.maxActionBudgetDeltaCents,
      maxActionBudgetDeltaPct: Number(control.maxActionBudgetDeltaPct),
      activePolicyVersion: control.activePolicyVersion,
    },
    metricsFresh: fresh,
    unresolvedWrites: unresolved,
    projectedDailySpendCents: input.projectedDailySpendCents ?? 0,
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

  await audit(input.actor ?? "system", "action.proposed", row.id, { status, result });
  if (status === "approved") await dispatch(row.id);
  return row;
}

export async function listQueue() {
  return getDb().select().from(adActions)
    .where(eq(adActions.status, "pending_approval"))
    .orderBy(desc(adActions.createdAt));
}

/** In-flight or post-crash writes awaiting reconciliation. Drives the unresolved-writes UI. */
export async function listUnresolved() {
  return getDb().select().from(adActions)
    .where(inArray(adActions.status, UNRESOLVED_STATUSES as unknown as string[]))
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
  await audit(actor, `action.${status}`, id, null, "operator-resolved uncertain write");
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
  await audit(actor, "action.approved", id);
  await dispatch(id);
  return row;
}

export async function rejectAction(id: string, actor = "operator") {
  const [row] = await getDb().update(adActions)
    .set({ status: "rejected" }).where(eq(adActions.id, id)).returning();
  await audit(actor, "action.rejected", id);
  return row;
}

/** Kill switch: halt all writes immediately. */
export async function engageKill(actor = "operator") {
  await ensureControl();
  const [row] = await getDb().update(automationControl)
    .set({ emergencyStop: true, writeMode: "off", updatedAt: new Date(), updatedBy: actor })
    .where(eq(automationControl.id, true)).returning();
  await audit(actor, "kill_switch.engaged", null);
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

export async function setControl(patch: ControlPatch, actor = "operator") {
  await ensureControl();
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
    .set(values).where(eq(automationControl.id, true)).returning();
  await audit(actor, "control.updated", null, JSON.stringify(patch));
  return row;
}

export async function listAudit(limit = 50) {
  return getDb().select().from(auditEvents).orderBy(desc(auditEvents.createdAt)).limit(limit);
}

// ── Executor — the ONLY path that writes to Meta ───────────────────────────────────

/** preflight re-check → apply absolute patch → reconcile. Runs inline (single-instance
 *  desktop build, no durable queue). Records every outcome; never rethrows to the caller —
 *  the Meta client retries transient errors internally, and the next poll reconciles
 *  anything left uncertain. ponytail: inline executor; add a durable queue if multi-instance. */
// Serialize ALL executor writes so only one Meta write runs at a time. This closes the TOCTOU
// where two concurrent dispatches both pass the unresolved-writes gate before either flips to
// `executing` (double-click, scheduler + UI, retries). Sufficient because the app is explicitly
// single-instance. ponytail: in-process mutex; for multi-instance, use a Postgres advisory lock
// held across preflight + the Meta write.
let writeChain: Promise<unknown> = Promise.resolve();
function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => {}, () => {});
  return run;
}

export function executeAdAction(actionId: string) {
  return serializeWrite(() => runExecute(actionId));
}

async function runExecute(actionId: string) {
  const pre = await preflightAction(actionId);
  if (!pre.allowed || (!pre.metaPayload && !pre.launch)) {
    return reconcileAction(actionId, { ok: false, error: `preflight: ${pre.reason}` });
  }
  let applied: ApplyResult;
  try {
    applied = pre.launch ? await runLaunch(actionId) : await applyAbsolutePatch(pre.metaPayload!);
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
async function runLaunch(actionId: string): Promise<ApplyResult> {
  const db = getDb();
  const [action] = await db.select().from(adActions).where(eq(adActions.id, actionId)).limit(1);
  const [ad] = await db.select().from(ads).where(eq(ads.id, action.entityId)).limit(1);
  if (!ad) throw new Error("launch: ad row not found");
  if (!ad.adsetId) throw new Error("launch: ad has no adsetId — supply an existing Meta adset");
  if (!ad.destinationUrl) throw new Error("launch: destinationUrl required");
  if (!ad.creativeId) throw new Error("launch: ad has no creative");
  const [creative] = await db.select().from(creatives).where(eq(creatives.id, ad.creativeId)).limit(1);
  if (!creative) throw new Error("launch: creative not found");

  const pageId = process.env.META_PAGE_ID;
  if (!pageId) throw new Error("launch: META_PAGE_ID not set");
  const accountId = process.env.META_AD_ACCOUNT_ID ?? "";
  const token = action.idempotencyKey;
  const tagged = `${ad.id} [launch:${token}]`;
  const copy = (ad.copy ?? {}) as { headline?: string; primaryText?: string; description?: string };

  // Phase 1 — AdCreative (durable: creatives.metaCreativeId)
  let creativeId = creative.metaCreativeId ?? null;
  if (!creativeId) {
    const found = await findByLaunchToken(accountId, "adcreatives", token);
    if (found.length > 1) throw new Error(`launch: ambiguous (${found.length}) creatives for token — manual cleanup`);
    creativeId = found[0] ?? await createAdCreative(accountId, {
      name: tagged, pageId, imageUrl: creative.blobUrl, link: ad.destinationUrl,
      message: copy.primaryText, headline: copy.headline, description: copy.description, cta: ad.cta ?? undefined,
    });
    await db.update(creatives).set({ metaCreativeId: creativeId }).where(eq(creatives.id, creative.id));
  }

  // Phase 2 — Ad, PAUSED (durable: ads.metaAdId)
  let metaAdId = ad.metaAdId ?? null;
  if (!metaAdId) {
    const found = await findByLaunchToken(accountId, "ads", token);
    if (found.length > 1) throw new Error(`launch: ambiguous (${found.length}) ads for token — manual cleanup`);
    metaAdId = found[0] ?? await createAdObject(accountId, { name: tagged, adsetId: ad.adsetId, creativeId });
    await db.update(ads).set({ metaAdId, status: "paused" }).where(eq(ads.id, ad.id));
  }

  return { ok: true, metaResponse: { creativeId, metaAdId } };
}

export interface Preflight { allowed: boolean; reason?: string; metaPayload?: AbsolutePatch; launch?: boolean }

const PAUSE_TYPES = new Set<ActionType>(["pause_ad", "pause_adset", "pause_campaign"]);
const BUDGET_TYPES = new Set<ActionType>(["set_budget", "decrease_budget", "increase_budget"]);

/** Re-check guardrails at execution time and build the absolute write payload. This is the
 *  ONLY gate before a Meta write, so it is deliberately strict and self-contained. */
export async function preflightAction(actionId: string): Promise<Preflight> {
  const db = getDb();
  const [action] = await db.select().from(adActions).where(eq(adActions.id, actionId)).limit(1);
  if (!action) return { allowed: false, reason: "not_found" };
  if (action.status !== "approved" && action.status !== "executing") return { allowed: false, reason: `status_${action.status}` };
  if (new Date(action.expiresAt) < new Date()) return { allowed: false, reason: "expired" };

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
    try { current = await getDailyBudgetCents(action.entityId); } catch { current = null; }
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
    try { scan = await fetchEnabledBudgets(); } catch { return { allowed: false, reason: "account_budget_unknown" }; }
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
      try { info = await getBudgetInfo(action.entityId); } catch { return { allowed: false, reason: "account_budget_unknown" }; }
      if (!info.isBudgetNode) addBack = 0;
      else if (info.lifetimeCents != null) return { allowed: false, reason: "lifetime_budget_unsupported" };
      else if (info.dailyCents != null) addBack = info.dailyCents;
      else {
        let child: Awaited<ReturnType<typeof fetchChildAdsetBudgets>>;
        try { child = await fetchChildAdsetBudgets(action.entityId); } catch { return { allowed: false, reason: "account_budget_unknown" }; }
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
  const control = await ensureControl();
  const fresh = await metricsFresh(control.minMetricFreshnessMinutes);
  const unresolved = await hasUnresolvedWrites(action.id);
  const result = evaluate(
    { actionType, policyVersion: action.policyVersion, dailyBudgetDeltaCents: deltaCents, dailyBudgetDeltaPct: deltaPct },
    {
      envWriteMode: ENV_WRITE_MODE,
      control: {
        writeMode: control.writeMode as GuardrailContext["control"]["writeMode"],
        emergencyStop: control.emergencyStop,
        maxAccountDailySpendCents: control.maxAccountDailySpendCents,
        maxActionBudgetDeltaCents: control.maxActionBudgetDeltaCents,
        maxActionBudgetDeltaPct: Number(control.maxActionBudgetDeltaPct),
        activePolicyVersion: control.activePolicyVersion,
      },
      metricsFresh: fresh,
      unresolvedWrites: unresolved,
      projectedDailySpendCents,
    },
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
  await db.update(adActions).set({ status }).where(eq(adActions.id, actionId));
  await audit("executor", `action.${status}`, actionId, outcome.metaResponse ?? null, outcome.error ?? null);
  return { status };
}

/** Post-write timeout: don't retry blindly — mark uncertain for reconciliation. */
export async function markUncertain(actionId: string, error: string) {
  await getDb().update(adActions).set({ status: "uncertain" }).where(eq(adActions.id, actionId));
  await audit("executor", "action.uncertain", actionId, null, error);
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
    .returning({ id: adActions.id });
  for (const r of rows) await audit("executor", "action.uncertain", r.id, null, "recovered: process restart mid-write");
  if (rows.length) console.warn(`[recovery] demoted ${rows.length} orphaned executing write(s) to uncertain`);
  return { recovered: rows.length };
}
