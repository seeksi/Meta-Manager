// M4 (WS-4) — importer mapping is hermetic (no server/DB): parse the ```actions block and build
// correctly-scoped POST bodies. Proves a proposal imported for client A never carries client B's
// id, that every row is origin-tagged + traceable, and that re-imports are idempotent.
import { describe, it, expect } from "vitest";
import { parseProposalActions, buildActionBody } from "./import-proposal";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

const PROPOSAL = `# Proposal — Acme Med Spa

\`\`\`actions
[
  { "actionType": "pause_campaign", "entityType": "campaign", "entityId": "120210000000001",
    "targetState": { "status": "PAUSED" },
    "auditFinding": "Branded-search campaign, 0 booked leads (audit §3)" },
  { "actionType": "decrease_budget", "entityType": "adset", "entityId": "120210000000777",
    "targetState": { "daily_budget": 2000 }, "dailyBudgetDeltaCents": -3000,
    "projectedDailySpendCents": 2000, "auditFinding": "Adset CPA 4x target (audit §5)" }
]
\`\`\`

## Manual onboarding tasks (not mapped)
- [ ] Enable CAPI + Lead event
`;

describe("M4 proposal importer mapping", () => {
  it("parses only the actions block (manual tasks ignored)", () => {
    const items = parseProposalActions(PROPOSAL);
    expect(items.map((i) => i.actionType)).toEqual(["pause_campaign", "decrease_budget"]);
  });

  it("rejects an unknown actionType", () => {
    const bad = '```actions\n[{ "actionType": "nuke_account", "entityType": "account", "entityId": "x", "targetState": {}, "auditFinding": "y" }]\n```';
    expect(() => parseProposalActions(bad)).toThrow();
  });

  it("requires an auditFinding on every item (no fabricated ROI)", () => {
    const bad = '```actions\n[{ "actionType": "pause_ad", "entityType": "ad", "entityId": "1", "targetState": { "status": "PAUSED" } }]\n```';
    expect(() => parseProposalActions(bad)).toThrow();
  });

  it("scopes every body to the given client, tags origin, traces the finding", () => {
    const items = parseProposalActions(PROPOSAL);
    const bodies = items.map((it) => buildActionBody(it, A, "prop123", "/p/proposal.md"));
    for (const b of bodies) {
      expect(b.clientId).toBe(A);
      expect(b.actor).toBe("proposal-closer");
      expect(b.evidence.auditFinding).toBeTruthy();
      expect(b.evidence.proposalId).toBe("prop123");
      expect(b).not.toHaveProperty("auditFinding"); // stripped from the engine payload
    }
  });

  it("importing for client A never produces client B's id", () => {
    const items = parseProposalActions(PROPOSAL);
    const forA = items.map((it) => buildActionBody(it, A, "p", "/x").clientId);
    expect(forA.every((id) => id === A)).toBe(true);
    expect(forA.some((id) => id === B)).toBe(false);
  });

  it("is idempotent per (client, action, entity, finding) and client-isolating in the key", () => {
    const [item] = parseProposalActions(PROPOSAL);
    const k1 = buildActionBody(item, A, "p1", "/x").idempotencyKey;
    const k2 = buildActionBody(item, A, "p2", "/y").idempotencyKey; // proposalId/path don't affect the key
    const kB = buildActionBody(item, B, "p1", "/x").idempotencyKey;
    expect(k1).toBe(k2);
    expect(k1).not.toBe(kB); // same fix for a different client is a distinct row
  });
});
