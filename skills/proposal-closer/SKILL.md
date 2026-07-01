---
name: proposal-closer
description: Turn a completed audit's findings into a fix-sprint or monthly-retainer proposal (the upsell), and route approved fixes into the Meta-Manager engine as scoped ad_actions proposals. Use when the user says proposal, close the deal, upsell, retainer offer, fix sprint, or quote <client>.
license: MIT
metadata:
  version: 1.1.0
  category: marketing
  updated: 2026-06-30
---

# Proposal Closer

Convert audit findings into paid implementation work. The audit recommends; this turns the
recommendations into a priced offer and routes approved work to execution.

## Input
- A completed audit (from `audit-full`) with its kill list + quick wins.
- The client record (from `client-tracker`).

## Process
1. Pull the audit's top issues. Group into: (a) quick wins (1–2 week fix sprint) and (b)
   ongoing optimization (retainer).
2. For each item, state the expected outcome in the client's terms (more booked leads, lower
   cost per booking, recovered wasted spend) — grounded in the audit, not invented numbers.
3. Build the proposal:
   - **Fix Sprint** (one-time, $1,000+): scoped list of quick wins, timeline, deliverables.
   - **Management Retainer** ($1,000–1,500+/mo): ongoing optimization + monthly re-audit +
     reporting. Premium positioning (see RESEARCH-FINDINGS.md).
   - Clear scope boundaries + the standard approval/disclaimer line.
4. Output `proposal.md` (and PDF via generate_report.py if a polished doc is wanted) under
   `AuditService/clients/<client>/`. In that proposal, emit the fixes that map to a Meta ad
   change inside a single fenced ` ```actions ` JSON array (the handoff contract — see below).
   Fixes with no ad-change mapping (enable CAPI/Lead event, write a real offer, 3 static
   creatives needing assets, speed-to-lead routing) go in a **Manual onboarding tasks**
   checklist instead — they are not part of the `actions` block.
5. On client acceptance: route the approved fixes into the **Meta-Manager** engine — they become
   scoped `ad_actions` proposal rows on the *same* guardrail/approval pipeline the optimizer
   uses (no ad-hoc changes, no second code path). Run the importer:
   ```
   cd /home/alter/AGENTS/projects/ADS/Meta-Manager
   npx tsx scripts/import-proposal.ts --file <path/to/proposal.md> --client <client uuid or name>
   ```
   (Set `OPERATOR_USERNAME`/`OPERATOR_PASSWORD` + `--base <engine URL>` when the engine is hosted
   and auth-gated.) New clients onboard in `observe` write mode, so the rows are created for the
   operator to review/apply — nothing is written to Meta automatically. Confirm the printed
   summary shows one row per action. Never execute ad changes ad hoc.
6. Update `client-tracker` (proposal sent / accepted / in-execution).

## Handoff contract — the ` ```actions ` block
One JSON array; each object maps an audit fix to one engine action. Valid `actionType`s come from
Meta-Manager `src/lib/guardrails.ts` (`pause_campaign`/`pause_adset`/`pause_ad`,
`decrease_budget`/`set_budget`/`increase_budget`, `create_campaign`, `launch_ad`,
`change_targeting`, `expand_audience`, `unpause`). Fields per object:
`actionType` (one of the above), `entityType` (account|campaign|adset|ad), `entityId` (the real
Meta object id — if unknown, leave the fix for the manual checklist), `targetState` (the ABSOLUTE
target, never a delta), `dailyBudgetDeltaCents` + `projectedDailySpendCents` (budget actions
only — guardrail caps read these), and `auditFinding` (required; traces to the audit, no
fabricated ROI).
```actions
[
  { "actionType": "pause_campaign", "entityType": "campaign", "entityId": "120210000000001",
    "targetState": { "status": "PAUSED" },
    "auditFinding": "Branded-search campaign, 0 booked leads (audit §3)" },
  { "actionType": "decrease_budget", "entityType": "adset", "entityId": "120210000000777",
    "targetState": { "daily_budget": 2000 }, "dailyBudgetDeltaCents": -3000,
    "projectedDailySpendCents": 2000, "auditFinding": "Adset CPA 4x target (audit §5)" }
]
```

## Guardrails
- All projected outcomes trace to audit findings; no fabricated ROI promises (`auditFinding` is
  required on every `actions` item).
- You don't run ads manually — approved fixes go through Meta-Manager's guardrail/approval
  pipeline (`ad_actions`), which re-runs guardrails at write time and respects WRITE_MODE, the
  kill switch, and spend caps.
- Pricing follows the decided premium ladder; discount via scope reduction, not race-to-bottom.

skipped: e-signature/invoicing integration, add when close volume justifies it (use a manual
invoice + calendar link first).
