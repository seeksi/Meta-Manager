// M5 Compliance gate — docs/M5-compliance-gate.orchestrator.md, spec §5.
// Pure, synchronous, versioned. Mirrors guardrails.ts (a typed result with an immutable ruleset
// version stamped on every eval) but INVERTS the default: compliance DEFAULTS TO PASS — only a
// positive rule match gates. The engine (automation.proposeAction) forces status 'blocked' on a
// `block`; FLAG is annotate-only (recorded, lifecycle unchanged).
//
// Content = med-spa health-ad ruleset (AuditService/PROCESS.html L411/L476 + spec §5). No
// mortgage/ECOA/RESPA logic. Per-client self-ban terms ride the `extraBlockTerms` seam until a
// real client needs one.
// ponytail: in-code regex ruleset v1 is enough for one med-spa vertical; upgrade to a DB-backed
// rules table + AI pre-filter at a 2nd vertical or when per-client rules land.

export const COMPLIANCE_VERSION = 1; // bump when rule CONTENT changes; stamped into every result.

export type ComplianceStatus = "pass" | "flag" | "block";

/** The normalized surface the gate inspects: creative text + the targeting object. */
export interface Reviewable {
  copy: string;
  targeting: Record<string, unknown>;
}

export interface ComplianceFinding {
  ruleId: string;
  severity: "flag" | "block";
  category: "creative" | "targeting" | "tcpa";
  message: string;
}

export interface ComplianceResult {
  status: ComplianceStatus;
  version: number;
  findings: ComplianceFinding[];
}

// BLOCK · creative — personal "you/your body" before-after framing (the canonical Meta health-ad
// rejection reason in PROCESS.html): personal-attribute address paired with before/after language.
const PERSONAL_ATTR = /\byou(r)?\s+(body|face|skin|figure|weight|results|jawline|lips|wrinkles)\b/i;
const BEFORE_AFTER = /before\s*(?:[&/+.-]|and)?\s*after/i;

// FLAG · creative — unsubstantiated results / medical-outcome claim without an FTC disclaimer.
const RESULTS_CLAIM = /\b(guarantee|guaranteed|permanent|risk[-\s]?free|lose \d+|\d+\s*(lbs|pounds|inches)|cure|eliminate|melt away)\b/i;
const DISCLAIMER = /results (not|may not be) typical|individual results (may )?vary/i;

// FLAG · tcpa — speed-to-lead SMS/call follow-up promised without consent language.
const CONTACT_PROMISE = /\b(we'?ll (call|text)|call you|text you|reminder text|call within)\b|\bsms\b/i;
const CONSENT = /\b(consent|opt[-\s]?in|reply stop|msg (&|and) data rates|by (submitting|providing))\b/i;

// BLOCK · targeting — interest/keyword terms that imply a personal health attribute (Meta forbids
// personal-health-attribute targeting). Matched case-insensitively against the targeting strings.
const HEALTH_TARGETING_TERMS = [
  "weight loss", "obesity", "obese", "diabetes", "diabetic", "erectile", "hair loss",
  "balding", "menopause", "wrinkles", "anti-aging", "acne", "cellulite", "depression",
  "anxiety", "hormone", "testosterone", "ozempic", "semaglutide", "botox patients",
];

/** All string leaves of an arbitrary value — used to normalize a targetState/evidence tree. */
export function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) collectStrings(x, out);
  return out;
}

/**
 * Run the med-spa ruleset. Returns the strongest severity (`block` > `flag` > `pass`) + all
 * findings. `extraBlockTerms` = optional per-client self-ban terms (the deferred exclusion seam);
 * empty by default so the federal/Meta ruleset stands alone.
 */
export function evaluateCompliance(r: Reviewable, extraBlockTerms: string[] = []): ComplianceResult {
  const findings: ComplianceFinding[] = [];
  const copy = r.copy ?? "";
  const targetingText = collectStrings(r.targeting ?? {}).join(" \n ").toLowerCase();

  if (BEFORE_AFTER.test(copy) && PERSONAL_ATTR.test(copy)) {
    findings.push({
      ruleId: "creative.personal_before_after", severity: "block", category: "creative",
      message: "Personal 'you/your body' before-after framing — reword to a general benefit (Meta health policy).",
    });
  }

  const hitTerm = HEALTH_TARGETING_TERMS.find((t) => targetingText.includes(t));
  if (hitTerm) {
    findings.push({
      ruleId: "targeting.personal_health_attribute", severity: "block", category: "targeting",
      message: `Targeting implies a personal health attribute ("${hitTerm}") — forbidden by Meta health policy.`,
    });
  }

  const haystack = `${copy}\n${targetingText}`.toLowerCase();
  for (const term of extraBlockTerms) {
    const t = term.trim().toLowerCase();
    if (t && haystack.includes(t)) {
      findings.push({
        ruleId: "client.excluded_term", severity: "block", category: "creative",
        message: `Client-excluded term present ("${term}").`,
      });
    }
  }

  if (RESULTS_CLAIM.test(copy) && !DISCLAIMER.test(copy)) {
    findings.push({
      ruleId: "creative.unsubstantiated_results", severity: "flag", category: "creative",
      message: "Unsubstantiated results/medical-outcome claim without an FTC 'results not typical' disclaimer.",
    });
  }

  if (CONTACT_PROMISE.test(copy) && !CONSENT.test(copy)) {
    findings.push({
      ruleId: "tcpa.contact_without_consent", severity: "flag", category: "tcpa",
      message: "SMS/call follow-up promised without consent language (TCPA).",
    });
  }

  const status: ComplianceStatus =
    findings.some((f) => f.severity === "block") ? "block"
    : findings.some((f) => f.severity === "flag") ? "flag"
    : "pass";
  return { status, version: COMPLIANCE_VERSION, findings };
}
