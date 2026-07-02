import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { ads, automationControl, clients, metaInsightsDaily } from "@/db/schema";
import { clientContext, getClient } from "@/lib/clients";
import { detectFatigue, recentInsightRows, type FatigueRow } from "@/lib/fatigue";
import { fetchEnabledBudgets } from "@/lib/meta/client";

export const AUDIT_ENGINE_VERSION = 1;

export type AuditSeverity = "critical" | "warn" | "info";
export type AuditCategory = "pixel_capi" | "creative" | "structure" | "audience";
export type AuditCheckStatus = "pass" | "warn" | "critical" | "not_assessed";

export interface AuditFinding {
  code: string;
  category: AuditCategory;
  severity: AuditSeverity;
  title: string;
  detail: string;
  recommendation: string;
  evidence?: unknown;
  autoFixable: boolean;
}

export interface AuditInputs {
  capiEnabled?: boolean;
  emqPurchase?: number;
  leadEventFiring?: boolean;
}

export interface AuditReport {
  score: number | null;
  version: number;
  findings: AuditFinding[];
  summary: unknown;
  assessed: string[];
  notAssessed: string[];
}

export interface AuditCheckResult {
  code: string;
  category: AuditCategory;
  status: AuditCheckStatus;
  finding?: AuditFinding;
}

interface InsightTotals {
  impressions: number;
  reach: number;
  clicks: number;
  days: number;
}

interface AdCopyRow {
  id: string;
  copy: unknown;
}

const CATEGORY_WEIGHTS: Record<AuditCategory, number> = {
  pixel_capi: 0.3,
  creative: 0.3,
  structure: 0.2,
  audience: 0.2,
};

const CATEGORY_ORDER: AuditCategory[] = ["pixel_capi", "creative", "structure", "audience"];
const STATUS_SCORE: Record<Exclude<AuditCheckStatus, "not_assessed">, number> = {
  pass: 100,
  warn: 50,
  critical: 0,
};

function finding(
  code: string,
  category: AuditCategory,
  severity: AuditSeverity,
  title: string,
  detail: string,
  recommendation: string,
  evidence?: unknown,
  autoFixable = false,
): AuditFinding {
  return { code, category, severity, title, detail, recommendation, evidence, autoFixable };
}

function pass(code: string, category: AuditCategory): AuditCheckResult {
  return { code, category, status: "pass" };
}

function assessedFinding(f: AuditFinding): AuditCheckResult {
  return { code: f.code, category: f.category, status: f.severity === "critical" ? "critical" : "warn", finding: f };
}

function notAssessed(
  code: string,
  category: AuditCategory,
  title: string,
  detail: string,
  recommendation: string,
  evidence?: unknown,
): AuditCheckResult {
  return {
    code,
    category,
    status: "not_assessed",
    finding: finding(code, category, "info", title, detail, recommendation, evidence, false),
  };
}

function isAssessed(check: AuditCheckResult): check is AuditCheckResult & { status: Exclude<AuditCheckStatus, "not_assessed"> } {
  return check.status !== "not_assessed";
}

function isFixFinding(check: AuditCheckResult): check is AuditCheckResult & { status: "critical" | "warn" } {
  return check.status === "critical" || check.status === "warn";
}

export function checkPixelPresent(pixelId: string | null | undefined): AuditCheckResult {
  if (pixelId?.trim()) return pass("pixel-present", "pixel_capi");
  return assessedFinding(finding(
    "pixel-present",
    "pixel_capi",
    "critical",
    "Pixel is missing",
    "This client has no pixel id stored, so the app cannot confirm a Meta Pixel is installed.",
    "Connect the client's Pixel before relying on conversion optimization or CAPI diagnostics.",
    { pixelId: pixelId ?? null },
    false,
  ));
}

export function checkCapiEnabled(inputs: AuditInputs = {}): AuditCheckResult {
  if (inputs.capiEnabled === undefined) {
    return notAssessed(
      "capi-enabled",
      "pixel_capi",
      "CAPI status not assessed",
      "Conversions API status is only visible from Events Manager or operator-provided evidence.",
      "Answer the CAPI questionnaire item after checking Events Manager.",
    );
  }
  if (inputs.capiEnabled) return pass("capi-enabled", "pixel_capi");
  return assessedFinding(finding(
    "capi-enabled",
    "pixel_capi",
    "critical",
    "Conversions API is off",
    "Operator input says CAPI is not enabled; post-iOS data loss can materially weaken delivery.",
    "Enable CAPI and verify event deduplication before scaling spend.",
    { capiEnabled: false },
    false,
  ));
}

export function checkEmqPurchase(inputs: AuditInputs = {}): AuditCheckResult {
  const emq = inputs.emqPurchase;
  if (emq === undefined) {
    return notAssessed(
      "emq-purchase",
      "pixel_capi",
      "Purchase EMQ not assessed",
      "Purchase Event Match Quality is not exposed through the Marketing API.",
      "Enter the Purchase EMQ score from Events Manager.",
    );
  }
  if (emq >= 8) return pass("emq-purchase", "pixel_capi");
  if (emq >= 6) {
    return assessedFinding(finding(
      "emq-purchase",
      "pixel_capi",
      "warn",
      "Purchase EMQ needs improvement",
      `Purchase EMQ is ${emq}; the pass threshold is 8.0 or higher.`,
      "Add more customer information parameters and verify CAPI/browser event matching.",
      { emqPurchase: emq, passAt: 8 },
      false,
    ));
  }
  return assessedFinding(finding(
    "emq-purchase",
    "pixel_capi",
    "critical",
    "Purchase EMQ is weak",
    `Purchase EMQ is ${emq}; scores below 6.0 are a critical signal quality issue.`,
    "Prioritize CAPI, enhanced matching, and event payload completeness.",
    { emqPurchase: emq, criticalBelow: 6 },
    false,
  ));
}

export function checkLeadEventFiring(inputs: AuditInputs = {}): AuditCheckResult {
  if (inputs.leadEventFiring === undefined) {
    return notAssessed(
      "lead-event-firing",
      "pixel_capi",
      "Lead event firing not assessed",
      "Lead event firing requires Events Manager or operator confirmation.",
      "Answer the Lead event questionnaire item after confirming recent event activity.",
    );
  }
  if (inputs.leadEventFiring) return pass("lead-event-firing", "pixel_capi");
  return assessedFinding(finding(
    "lead-event-firing",
    "pixel_capi",
    "critical",
    "Lead event is not firing",
    "Operator input says the Lead event is not firing, so lead optimization lacks its primary signal.",
    "Fix Lead event instrumentation and confirm recent event volume in Events Manager.",
    { leadEventFiring: false },
    false,
  ));
}

export function checkCtrLow(totals: InsightTotals | null): AuditCheckResult {
  if (!totals || totals.impressions <= 0) {
    return notAssessed(
      "ctr-low",
      "creative",
      "CTR not assessed",
      "No 7-day account impression data is available in stored Meta insights.",
      "Ingest account-level insights, then rerun the audit.",
      totals,
    );
  }
  const ctr = totals.clicks / totals.impressions;
  if (ctr >= 0.01) return pass("ctr-low", "creative");
  if (ctr >= 0.005) {
    return assessedFinding(finding(
      "ctr-low",
      "creative",
      "warn",
      "CTR is below target",
      `7-day account CTR is ${(ctr * 100).toFixed(2)}%; the pass threshold is 1.00%.`,
      "Refresh hooks, offers, or creative angles before increasing spend.",
      { ctr, clicks: totals.clicks, impressions: totals.impressions },
      false,
    ));
  }
  return assessedFinding(finding(
    "ctr-low",
    "creative",
    "critical",
    "CTR is critically low",
    `7-day account CTR is ${(ctr * 100).toFixed(2)}%, below the 0.50% fail threshold.`,
    "Prioritize new creative concepts and pause budget increases until click-through recovers.",
    { ctr, clicks: totals.clicks, impressions: totals.impressions },
    false,
  ));
}

export function checkCreativeFatigue(rows: FatigueRow[], hasInsightData: boolean): AuditCheckResult {
  if (!hasInsightData) {
    return notAssessed(
      "creative-fatigue",
      "creative",
      "Creative fatigue not assessed",
      "No stored campaign insights are available, so creative fatigue cannot be evaluated.",
      "Ingest campaign-level insights, then rerun the audit.",
    );
  }
  if (rows.length === 0) return pass("creative-fatigue", "creative");
  // ponytail: use 3 flagged campaign rows as the M-A1 account-level ceiling; upgrade to
  // percent-of-active-campaigns once campaign inventory reads land in M-A1.5.
  const severity: AuditSeverity = rows.length >= 3 ? "critical" : "warn";
  return assessedFinding(finding(
    "creative-fatigue",
    "creative",
    severity,
    severity === "critical" ? "Creative fatigue is broad" : "Creative fatigue detected",
    `${rows.length} campaign${rows.length === 1 ? "" : "s"} show fatigue signals from stored insights.`,
    "Refresh the affected creative angles and watch frequency/CTR before scaling.",
    { fatigued: rows.slice(0, 10) },
    false,
  ));
}

function copyText(copy: unknown, key: "headline" | "primary"): string {
  if (!copy || typeof copy !== "object") return "";
  const record = copy as Record<string, unknown>;
  const raw = key === "headline"
    ? record.headline
    : record.primary ?? record.primaryText ?? record.body;
  return typeof raw === "string" ? raw : "";
}

export function checkCopyLength(rows: AdCopyRow[]): AuditCheckResult | null {
  if (rows.length === 0) return null;
  const violations = rows
    .map((row) => {
      const headline = copyText(row.copy, "headline");
      const primary = copyText(row.copy, "primary");
      return {
        id: row.id,
        headlineLength: headline.length,
        primaryLength: primary.length,
        headlineTooLong: headline.length > 40,
        primaryTooLong: primary.length > 125,
      };
    })
    .filter((row) => row.headlineTooLong || row.primaryTooLong);
  if (violations.length === 0) return pass("copy-length", "creative");
  return assessedFinding(finding(
    "copy-length",
    "creative",
    "warn",
    "App-created copy is long",
    `${violations.length} app-created ad${violations.length === 1 ? "" : "s"} exceed headline or primary text guidance.`,
    "Tighten headlines to 40 characters or less and primary text to 125 characters or less.",
    { violations },
    false,
  ));
}

// ponytail: a trustworthy 7-day cumulative frequency needs deduplicated period reach, which
// summed daily reach cannot produce (Σimpr/Σreach collapses to average *daily* frequency). So M-A1
// defers this check — it stays "not assessed" and drops from the score until M-A1.5 adds the live
// period-reach Meta read. Upgrade path: fetch account reach over the window, then Σimpr/reach.
export function checkFrequencyHigh(): AuditCheckResult {
  return notAssessed(
    "frequency-high",
    "audience",
    "Frequency not assessed (deferred to M-A1.5)",
    "A trustworthy 7-day frequency needs deduplicated period reach, which stored daily rows cannot be summed to. Deferred until the M-A1.5 live reach read.",
    "No action needed; frequency will be scored once M-A1.5 adds the period-reach read.",
  );
}

export function checkBudgetVsCpa(args: {
  daily: Record<string, number>;
  hasLifetime: boolean;
  targetCpaCents: number | null;
  metaError?: string;
}): AuditCheckResult {
  if (args.metaError) {
    return notAssessed(
      "budget-vs-cpa",
      "structure",
      "Budget scan not assessed",
      "The live read-only Meta budget scan failed, so this check did not affect the score.",
      "Confirm the Meta token/account connection and rerun the audit.",
      { error: args.metaError },
    );
  }
  if (args.hasLifetime) {
    return notAssessed(
      "budget-vs-cpa",
      "structure",
      "Lifetime budgets not assessed",
      "At least one enabled budget node uses a lifetime budget, which cannot be converted safely to daily CPA coverage.",
      "Review lifetime budgets manually or switch to daily budgets before using this check.",
      { hasLifetime: true },
    );
  }
  if (!args.targetCpaCents || args.targetCpaCents <= 0) {
    return notAssessed(
      "budget-vs-cpa",
      "structure",
      "Target CPA not assessed",
      "No positive target CPA is configured for this client.",
      "Set automation_control.target_cpa_cents, then rerun the audit.",
      { targetCpaCents: args.targetCpaCents },
    );
  }
  const entries = Object.entries(args.daily);
  if (entries.length === 0) {
    return notAssessed(
      "budget-vs-cpa",
      "structure",
      "Enabled budgets not assessed",
      "No enabled daily budget nodes were returned by the read-only Meta scan.",
      "Confirm campaigns/ad sets are active and rerun the audit.",
      { dailyCount: 0 },
    );
  }
  const nodes = entries.map(([id, dailyCents]) => ({
    id,
    dailyCents,
    multiple: dailyCents / args.targetCpaCents!,
  })).sort((a, b) => a.multiple - b.multiple);
  const worst = nodes[0];
  if (worst.multiple < 2) {
    return assessedFinding(finding(
      "budget-vs-cpa",
      "structure",
      "critical",
      "Budget is below CPA learning coverage",
      `Worst enabled budget is ${(worst.multiple).toFixed(2)}x target CPA, below the 2x fail threshold.`,
      "Raise budget coverage or consolidate budget into fewer active learning nodes.",
      { targetCpaCents: args.targetCpaCents, worst, nodes },
      false,
    ));
  }
  if (worst.multiple < 5) {
    return assessedFinding(finding(
      "budget-vs-cpa",
      "structure",
      "warn",
      "Budget may be too thin for learning",
      `Worst enabled budget is ${(worst.multiple).toFixed(2)}x target CPA; pass threshold is 5x.`,
      "Move toward at least 5x target CPA per enabled budget node.",
      { targetCpaCents: args.targetCpaCents, worst, nodes },
      false,
    ));
  }
  return pass("budget-vs-cpa", "structure");
}

export function scoreAudit(checks: Array<AuditCheckResult | null>): AuditReport {
  const results = checks.filter((check): check is AuditCheckResult => check !== null);
  const byCategory = {} as Record<AuditCategory, {
    score: number | null;
    assessed: number;
    counts: Record<"pass" | "warn" | "critical" | "notAssessed", number>;
  }>;
  let weighted = 0;
  let weightSum = 0;

  for (const category of CATEGORY_ORDER) {
    const categoryResults = results.filter((check) => check.category === category);
    const assessed = categoryResults.filter(isAssessed);
    const counts = {
      pass: categoryResults.filter((check) => check.status === "pass").length,
      warn: categoryResults.filter((check) => check.status === "warn").length,
      critical: categoryResults.filter((check) => check.status === "critical").length,
      notAssessed: categoryResults.filter((check) => check.status === "not_assessed").length,
    };
    const categoryScore = assessed.length === 0
      ? null
      : Math.round(assessed.reduce((sum, check) => sum + STATUS_SCORE[check.status], 0) / assessed.length);
    byCategory[category] = { score: categoryScore, assessed: assessed.length, counts };
    if (categoryScore !== null) {
      weighted += CATEGORY_WEIGHTS[category] * categoryScore;
      weightSum += CATEGORY_WEIGHTS[category];
    }
  }

  // Only assessed warn/critical checks are real findings; not_assessed checks carry an info
  // placeholder that belongs in `notAssessed`/the summary chip, not the findings list.
  const findings = results.filter(isFixFinding).map((check) => check.finding!);
  const assessed = results.filter(isAssessed).map((check) => check.code);
  const notAssessedCodes = results.filter((check) => check.status === "not_assessed").map((check) => check.code);
  const topFixes = results
    .filter(isFixFinding)
    .sort((a, b) => STATUS_SCORE[a.status] - STATUS_SCORE[b.status])
    .map((check) => check.code)
    .slice(0, 5);

  return {
    score: weightSum === 0 ? null : Math.round(weighted / weightSum),
    version: AUDIT_ENGINE_VERSION,
    findings,
    summary: { byCategory, notAssessed: notAssessedCodes, topFixes },
    assessed,
    notAssessed: notAssessedCodes,
  };
}

function sumAccountInsights(rows: Array<typeof metaInsightsDaily.$inferSelect>): InsightTotals | null {
  const accountRows = rows.filter((row) => row.entityType === "account");
  if (accountRows.length === 0) return null;
  const days = new Set(accountRows.map((row) => String(row.dateStart).slice(0, 10))).size;
  return accountRows.reduce<InsightTotals>((sum, row) => ({
    impressions: sum.impressions + row.impressions,
    reach: sum.reach + row.reach,
    clicks: sum.clicks + row.clicks,
    days,
  }), { impressions: 0, reach: 0, clicks: 0, days });
}

async function targetCpaCents(clientId: string): Promise<number | null> {
  const [row] = await getDb().select({ targetCpaCents: automationControl.targetCpaCents })
    .from(automationControl)
    .where(eq(automationControl.clientId, clientId))
    .limit(1);
  return row?.targetCpaCents ?? null;
}

async function appCreatedCopy(clientId: string): Promise<AdCopyRow[]> {
  const rows = await getDb().select({ id: ads.id, copy: ads.copy })
    .from(ads)
    .where(eq(ads.clientId, clientId));
  return rows.filter((row) => row.copy !== null);
}

export async function runAudit(clientId: string, inputs: AuditInputs = {}): Promise<AuditReport> {
  const client = await getClient(clientId);
  if (!client) throw new Error(`unknown client: ${clientId}`);

  const [windowRows, fatigueRows, copyRows, target] = await Promise.all([
    recentInsightRows(client.metaAccountId),
    detectFatigue(clientId),
    appCreatedCopy(clientId),
    targetCpaCents(clientId),
  ]);
  const insights = sumAccountInsights(windowRows);
  const hasCampaignData = windowRows.some((row) => row.entityType === "campaign");

  let budgetInput: Parameters<typeof checkBudgetVsCpa>[0];
  try {
    const ctx = await clientContext(clientId);
    const budgets = await fetchEnabledBudgets(ctx);
    budgetInput = { ...budgets, targetCpaCents: target };
  } catch (e) {
    budgetInput = {
      daily: {},
      hasLifetime: false,
      targetCpaCents: target,
      metaError: e instanceof Error ? e.message : String(e),
    };
  }

  return scoreAudit([
    checkPixelPresent(client.pixelId),
    checkCapiEnabled(inputs),
    checkEmqPurchase(inputs),
    checkLeadEventFiring(inputs),
    checkCtrLow(insights),
    checkCreativeFatigue(fatigueRows, hasCampaignData),
    checkCopyLength(copyRows),
    checkFrequencyHigh(),
    checkBudgetVsCpa(budgetInput),
  ]);
}
