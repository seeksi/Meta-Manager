// M4 regression: POST /api/actions validates the body with ProposeInputSchema. Its clientId check
// must match the app's own client-id contract (lax UUID_RE in clients.ts), NOT Zod's strict RFC
// uuid — otherwise the endpoint rejects its own default/bootstrap client id (…0001), whose
// version/variant nibbles are 0. Direct proposeAction() calls skip the schema, so this boundary
// was never covered until the proposal-import pipeline (M4) became its first external caller.
import { describe, it, expect } from "vitest";
import { ProposeInputSchema } from "@/lib/automation";
import { BOOTSTRAP_CLIENT_ID } from "@/lib/clients";

const base = {
  actionType: "pause_campaign" as const,
  entityType: "campaign" as const,
  entityId: "c1",
  targetState: { status: "PAUSED" },
};

describe("ProposeInputSchema.clientId accepts the app's client-id contract", () => {
  it("accepts the bootstrap sentinel client id (…0001)", () => {
    expect(ProposeInputSchema.safeParse({ ...base, clientId: BOOTSTRAP_CLIENT_ID }).success).toBe(true);
  });

  it("rejects a non-uuid client id", () => {
    expect(ProposeInputSchema.safeParse({ ...base, clientId: "not-a-uuid" }).success).toBe(false);
  });
});
