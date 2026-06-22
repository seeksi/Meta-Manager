// Autonomy service layer — docs/ARCHITECTURE.md §5. DB-backed propose → guardrail →
// (Tier A ready | Tier B pending_approval | blocked) → approve/reject → dispatch to the
// executor (Inngest). Every state change is audited. This module never writes to Meta.
import { eq, desc, sql, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { automationControl, adActions, actionAttempts, auditEvents, metricFetches, ads, creatives } from "@/db/schema";
import {
  evaluate, tierOf, type ActionType, type ProposedAction, type GuardrailContext,
} from "./guardrails";
import {
  applyAbsolutePatch, findByLaunchToken, createAdCreative, createAdObject,
  type AbsolutePatch, type ApplyResult,
} from "@/lib/meta/client";

const ENV_WRITE_MODE = (process.env.WRITE_MODE ?? "off") as GuardrailContext["envWriteMode"];

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

/** True if any write is in-flight or uncertain. Gates new spend-increasing proposals (fail closed). */
async function hasUnresolvedWrites(): Promise<boolean> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(adActions)
    .where(inArray(adActions.status, UNRESOLVED_STATUSES as unknown as string[]));
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

/** Approve a Tier B action: re-check happens at executor preflight, then dispatch. */
export async function approveAction(id: string, actor = "operator") {
  const [row] = await getDb().update(adActions)
    .set({ status: "approved" }).where(eq(adActions.id, id)).returning();
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
const WRITABLE_FIELDS = new Set(["status", "daily_budget", "lifetime_budget", "name"]);

/** preflight re-check → apply absolute patch → reconcile. Runs inline (single-instance
 *  desktop build, no durable queue). Records every outcome; never rethrows to the caller —
 *  the Meta client retries transient errors internally, and the next poll reconciles
 *  anything left uncertain. ponytail: inline executor; add a durable queue if multi-instance. */
export async function executeAdAction(actionId: string) {
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

/** Re-check guardrails at execution time and build the absolute write payload. */
export async function preflightAction(actionId: string): Promise<Preflight> {
  const db = getDb();
  const [action] = await db.select().from(adActions).where(eq(adActions.id, actionId)).limit(1);
  if (!action) return { allowed: false, reason: "not_found" };
  if (action.status !== "approved" && action.status !== "executing") return { allowed: false, reason: `status_${action.status}` };
  if (new Date(action.expiresAt) < new Date()) return { allowed: false, reason: "expired" };

  if (ENV_WRITE_MODE === "off") return { allowed: false, reason: "ENV_WRITE_DISABLED" };
  const control = await ensureControl();
  if (control.emergencyStop || control.writeMode === "off") return { allowed: false, reason: "KILL_SWITCH" };
  if (action.policyVersion !== control.activePolicyVersion) return { allowed: false, reason: "POLICY_CHANGED" };

  // Launch is a create saga (handled by runLaunch), not an absolute patch.
  if (action.actionType === "launch_ad") return { allowed: true, launch: true };

  // Only absolute, writable fields. Reject non-absolute budget targets (e.g. pct placeholders).
  const target = (action.targetState ?? {}) as Record<string, unknown>;
  const fields: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(target)) {
    if (!WRITABLE_FIELDS.has(k)) continue;
    if (k === "daily_budget" && !Number.isInteger(v)) continue; // must be absolute minor units
    fields[k] = v as string | number | boolean;
  }
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
