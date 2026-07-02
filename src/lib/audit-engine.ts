import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { ads, automationControl, metaInsightsDaily } from "@/db/schema";
import { clientContext, getClient } from "@/lib/clients";
import { detectFatigue, recentInsightRows, type FatigueRow } from "@/lib/fatigue";
import {
  fetchAccountReach,
  fetchAdsWithCreative,
  fetchAdsetsDetail,
  fetchCampaigns,
  fetchEnabledBudgets,
  type AdCreativeRow,
  type AdsetDetailRow,
  type CampaignRow,
  type MetaCtx,
} from "@/lib/meta/client";

export const AUDIT_ENGINE_VERSION = 2;

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

export function checkCreativeFatigue(
  rows: FatigueRow[],
  hasInsightData: boolean,
  activeCampaignCount: number | null = null,
): AuditCheckResult {
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
  // >30% of active campaigns fatigued → critical; any fatigue → warn; none → pass. When the live
  // active-campaign denominator is unavailable (fetchCampaigns failed / no active campaigns) fall
  // back to an absolute-count ceiling (≥3 fatigued campaigns → critical) so a broadly-fatigued
  // account still escalates instead of being capped at warn.
  const pct = activeCampaignCount && activeCampaignCount > 0 ? rows.length / activeCampaignCount : null;
  const severity: AuditSeverity = pct !== null
    ? (pct > 0.3 ? "critical" : "warn")
    : (rows.length >= 3 ? "critical" : "warn");
  const share = pct !== null ? ` (${Math.round(Math.min(pct, 1) * 100)}% of ${activeCampaignCount} active campaigns)` : "";
  return assessedFinding(finding(
    "creative-fatigue",
    "creative",
    severity,
    severity === "critical" ? "Creative fatigue is broad" : "Creative fatigue detected",
    `${rows.length} campaign${rows.length === 1 ? "" : "s"} show fatigue signals from stored insights${share}.`,
    "Refresh the affected creative angles and watch frequency/CTR before scaling.",
    { fatigued: rows.slice(0, 10), activeCampaignCount, pct },
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

// Real 7-day account frequency from deduplicated period reach (impressions/reach). >5 → critical,
// 3–5 → warn, <3 → pass. Needs the live period-reach read (fetchAccountReach); summed daily reach
// cannot produce a valid period frequency, which is why M-A1 deferred this.
export function checkFrequencyHigh(
  reach: { impressions: number; reach: number } | null,
  metaError?: string,
): AuditCheckResult {
  if (metaError) {
    return notAssessed(
      "frequency-high",
      "audience",
      "Frequency not assessed",
      "The live read-only period-reach scan failed, so account frequency did not affect the score.",
      "Confirm the Meta token/account connection (and insights scope) and rerun the audit.",
      { error: metaError },
    );
  }
  if (!reach || reach.reach <= 0) {
    return notAssessed(
      "frequency-high",
      "audience",
      "Frequency not assessed",
      "No deduplicated period reach was returned, so 7-day frequency cannot be computed.",
      "Confirm the account has recent delivery, then rerun the audit.",
      reach,
    );
  }
  const freq = reach.impressions / reach.reach;
  if (!Number.isFinite(freq)) {
    return notAssessed(
      "frequency-high",
      "audience",
      "Frequency not assessed",
      "Period reach returned non-numeric impressions/reach, so frequency could not be computed.",
      "Confirm the account has valid recent delivery, then rerun the audit.",
      reach,
    );
  }
  if (freq > 5) {
    return assessedFinding(finding(
      "frequency-high",
      "audience",
      "critical",
      "Frequency is critically high",
      `7-day account frequency is ${freq.toFixed(2)}, above the 5.0 fail threshold — audience saturation.`,
      "Expand or refresh audiences and rotate creative before spending more.",
      { frequency: freq, ...reach },
      false,
    ));
  }
  if (freq >= 3) {
    return assessedFinding(finding(
      "frequency-high",
      "audience",
      "warn",
      "Frequency is elevated",
      `7-day account frequency is ${freq.toFixed(2)}; the pass threshold is below 3.0.`,
      "Watch for fatigue and broaden audiences or refresh creative if CTR declines.",
      { frequency: freq, ...reach },
      false,
    ));
  }
  return pass("frequency-high", "audience");
}

const ACTIVE_STATUS = "ACTIVE";

export function checkCampaignCount(campaigns: CampaignRow[] | null, metaError?: string): AuditCheckResult {
  if (metaError || !campaigns) {
    return notAssessed(
      "campaign-count",
      "structure",
      "Campaign count not assessed",
      "The live read-only campaign list scan failed, so this check did not affect the score.",
      "Confirm the Meta token/account connection (and ads_read scope) and rerun the audit.",
      { error: metaError },
    );
  }
  const active = campaigns.filter((c) => c.effectiveStatus === ACTIVE_STATUS);
  if (active.length === 0) {
    return notAssessed(
      "campaign-count",
      "structure",
      "Campaign count not assessed",
      "No active campaigns were returned by the read-only scan, so structure cannot be judged.",
      "Confirm campaigns are active, then rerun the audit.",
      { active: 0 },
    );
  }
  if (active.length > 3) {
    return assessedFinding(finding(
      "campaign-count",
      "structure",
      "warn",
      "Too many active campaigns",
      `${active.length} campaigns are active; more than 3 fragments budget and slows learning.`,
      "Consolidate into fewer active campaigns so budget and signal concentrate.",
      { active: active.length },
      false,
    ));
  }
  return pass("campaign-count", "structure");
}

export function checkCboVsAbo(campaigns: CampaignRow[] | null, metaError?: string): AuditCheckResult {
  if (metaError || !campaigns) {
    return notAssessed(
      "cbo-vs-abo",
      "structure",
      "Budget model not assessed",
      "The live read-only campaign list scan failed, so CBO-vs-ABO could not be evaluated.",
      "Confirm the Meta token/account connection (and ads_read scope) and rerun the audit.",
      { error: metaError },
    );
  }
  const active = campaigns.filter((c) => c.effectiveStatus === ACTIVE_STATUS);
  if (active.length === 0) {
    return notAssessed(
      "cbo-vs-abo",
      "structure",
      "Budget model not assessed",
      "No active campaigns were returned by the read-only scan.",
      "Confirm campaigns are active, then rerun the audit.",
      { active: 0 },
    );
  }
  // A campaign carrying its own budget = CBO; one without = ABO (budget lives on its adsets).
  const cbo = active.filter((c) => c.dailyCents != null || c.lifetimeCents != null).length;
  const abo = active.length - cbo;
  if (cbo > 0 && abo > 0) {
    return assessedFinding(finding(
      "cbo-vs-abo",
      "structure",
      "warn",
      "Mixed CBO and ABO campaigns",
      `${cbo} campaign${cbo === 1 ? " uses" : "s use"} campaign budget and ${abo} use${abo === 1 ? "s" : ""} ad-set budget.`,
      "Standardize on one budget model (Advantage campaign budget is usually simpler to scale).",
      { cbo, abo },
      false,
    ));
  }
  return pass("cbo-vs-abo", "structure");
}

export function checkLearningLimited(adsets: AdsetDetailRow[] | null, metaError?: string): AuditCheckResult {
  if (metaError || !adsets) {
    return notAssessed(
      "learning-limited",
      "structure",
      "Learning stage not assessed",
      "The live read-only adset scan failed, so learning-limited share could not be evaluated.",
      "Confirm the Meta token/account connection (and ads_read scope) and rerun the audit.",
      { error: metaError },
    );
  }
  const active = adsets.filter((a) => a.effectiveStatus === ACTIVE_STATUS);
  if (active.length === 0) {
    return notAssessed(
      "learning-limited",
      "structure",
      "Learning stage not assessed",
      "No active ad sets were returned by the read-only scan.",
      "Confirm ad sets are active, then rerun the audit.",
      { active: 0 },
    );
  }
  const limited = active.filter((a) => a.learningStage === "LEARNING_LIMITED");
  const share = limited.length / active.length;
  const evidence = { limited: limited.length, active: active.length, share };
  if (share > 0.5) {
    return assessedFinding(finding(
      "learning-limited",
      "structure",
      "critical",
      "Most ad sets are learning limited",
      `${limited.length} of ${active.length} active ad sets (${Math.round(share * 100)}%) are learning limited.`,
      "Consolidate ad sets and raise budget/events so learning can complete.",
      evidence,
      false,
    ));
  }
  if (share > 0.2) {
    return assessedFinding(finding(
      "learning-limited",
      "structure",
      "warn",
      "Several ad sets are learning limited",
      `${limited.length} of ${active.length} active ad sets (${Math.round(share * 100)}%) are learning limited.`,
      "Consolidate low-volume ad sets so each clears the learning threshold.",
      evidence,
      false,
    ));
  }
  return pass("learning-limited", "structure");
}

function activeAdsByAdset(ads: AdCreativeRow[]): Map<string, AdCreativeRow[]> {
  const byAdset = new Map<string, AdCreativeRow[]>();
  for (const ad of ads) {
    if (ad.effectiveStatus !== ACTIVE_STATUS) continue;
    const key = ad.adsetId ?? "unknown";
    const arr = byAdset.get(key) ?? [];
    arr.push(ad);
    byAdset.set(key, arr);
  }
  return byAdset;
}

export function checkFormatDiversity(ads: AdCreativeRow[] | null, metaError?: string): AuditCheckResult {
  if (metaError || !ads) {
    return notAssessed(
      "format-diversity",
      "creative",
      "Format diversity not assessed",
      "The live read-only ads/creatives scan failed, so format diversity could not be evaluated.",
      "Confirm the Meta token/account connection (and ads_read scope) and rerun the audit.",
      { error: metaError },
    );
  }
  const byAdset = activeAdsByAdset(ads);
  if (byAdset.size === 0) {
    return notAssessed(
      "format-diversity",
      "creative",
      "Format diversity not assessed",
      "No active ads were returned by the read-only scan.",
      "Confirm ads are active, then rerun the audit.",
      { activeAdsets: 0 },
    );
  }
  const thin = [...byAdset.entries()]
    .map(([adsetId, group]) => ({ adsetId, formats: new Set(group.map((a) => a.format ?? "unknown")).size }))
    .filter((row) => row.formats < 3);
  if (thin.length === 0) return pass("format-diversity", "creative");
  return assessedFinding(finding(
    "format-diversity",
    "creative",
    "warn",
    "Low creative format diversity",
    `${thin.length} active ad set${thin.length === 1 ? "" : "s"} run fewer than 3 distinct creative formats.`,
    "Add more creative formats per ad set (image, video, carousel) to feed retrieval.",
    { thin: thin.slice(0, 10) },
    false,
  ));
}

export function checkCreativesPerAdset(ads: AdCreativeRow[] | null, metaError?: string): AuditCheckResult {
  if (metaError || !ads) {
    return notAssessed(
      "creatives-per-adset",
      "creative",
      "Creatives per ad set not assessed",
      "The live read-only ads/creatives scan failed, so ad count per ad set could not be evaluated.",
      "Confirm the Meta token/account connection (and ads_read scope) and rerun the audit.",
      { error: metaError },
    );
  }
  const byAdset = activeAdsByAdset(ads);
  if (byAdset.size === 0) {
    return notAssessed(
      "creatives-per-adset",
      "creative",
      "Creatives per ad set not assessed",
      "No active ads were returned by the read-only scan.",
      "Confirm ads are active, then rerun the audit.",
      { activeAdsets: 0 },
    );
  }
  const thin = [...byAdset.entries()]
    .map(([adsetId, group]) => ({ adsetId, ads: group.length }))
    .filter((row) => row.ads < 5);
  if (thin.length === 0) return pass("creatives-per-adset", "creative");
  return assessedFinding(finding(
    "creatives-per-adset",
    "creative",
    "warn",
    "Too few creatives per ad set",
    `${thin.length} active ad set${thin.length === 1 ? "" : "s"} run fewer than 5 ads.`,
    "Add creatives so each ad set has at least 5 ads for the system to optimize across.",
    { thin: thin.slice(0, 10) },
    false,
  ));
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

// Trailing 7-day window (today-6 … today) as YYYY-MM-DD, for the live period-reach read.
function trailing7d(): [string, string] {
  const until = new Date();
  const since = new Date(until.getTime() - 6 * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return [fmt(since), fmt(until)];
}

// Run one live Meta read, degrading to { error } instead of throwing. A null ctx (clientContext
// failed) short-circuits to the ctx error so no read is attempted with a bad context.
async function safeRead<T>(
  ctx: MetaCtx | null,
  ctxError: string | undefined,
  fn: (ctx: MetaCtx) => Promise<T>,
): Promise<{ data?: T; error?: string }> {
  if (!ctx) return { error: ctxError ?? "Meta context unavailable" };
  try {
    return { data: await fn(ctx) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
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

  // Every live read degrades independently: a Meta/scope failure yields metaError → not_assessed,
  // never a thrown run. clientContext failing degrades all live reads at once.
  let ctx: MetaCtx | null = null;
  let ctxError: string | undefined;
  try {
    ctx = await clientContext(clientId);
  } catch (e) {
    ctxError = e instanceof Error ? e.message : String(e);
  }

  const [budgetsRead, campaignsRead, adsetsRead, adsRead, reachRead] = await Promise.all([
    safeRead(ctx, ctxError, (c) => fetchEnabledBudgets(c)),
    safeRead(ctx, ctxError, (c) => fetchCampaigns(c)),
    safeRead(ctx, ctxError, (c) => fetchAdsetsDetail(c)),
    safeRead(ctx, ctxError, (c) => fetchAdsWithCreative(c)),
    safeRead(ctx, ctxError, (c) => fetchAccountReach(c, ...trailing7d())),
  ]);

  const budgetInput: Parameters<typeof checkBudgetVsCpa>[0] = budgetsRead.error
    ? { daily: {}, hasLifetime: false, targetCpaCents: target, metaError: budgetsRead.error }
    : { ...budgetsRead.data!, targetCpaCents: target };
  const activeCampaigns = campaignsRead.data
    ? campaignsRead.data.filter((c) => c.effectiveStatus === ACTIVE_STATUS).length
    : null;

  return scoreAudit([
    checkPixelPresent(client.pixelId),
    checkCapiEnabled(inputs),
    checkEmqPurchase(inputs),
    checkLeadEventFiring(inputs),
    checkCtrLow(insights),
    checkCreativeFatigue(fatigueRows, hasCampaignData, activeCampaigns),
    checkCopyLength(copyRows),
    checkFrequencyHigh(reachRead.data ?? null, reachRead.error),
    checkBudgetVsCpa(budgetInput),
    checkCampaignCount(campaignsRead.data ?? null, campaignsRead.error),
    checkCboVsAbo(campaignsRead.data ?? null, campaignsRead.error),
    checkLearningLimited(adsetsRead.data ?? null, adsetsRead.error),
    checkFormatDiversity(adsRead.data ?? null, adsRead.error),
    checkCreativesPerAdset(adsRead.data ?? null, adsRead.error),
  ]);
}
