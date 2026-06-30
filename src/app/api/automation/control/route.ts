import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getControl, ensureControl, setControl,
  getAgencyControl, ensureAgencyControl, setAgencyControl,
} from "@/lib/automation";
import { isInvalidClientIdError, resolveClientId } from "@/lib/clients";

export async function GET(req: Request) {
  try {
    if (new URL(req.url).searchParams.get("scope") === "agency") {
      const control = (await getAgencyControl()) ?? (await ensureAgencyControl());
      return NextResponse.json({ control });
    }
    const clientId = resolveClientId(req);
    const control = (await getControl(clientId)) ?? (await ensureControl(clientId));
    return NextResponse.json({ control });
  } catch (e) {
    console.error("[control] GET failed:", e);
    if (isInvalidClientIdError(e)) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: "internal error" }, { status: 503 });
  }
}

// Safety-critical trust boundary: this is the only way to lift caps / release the kill switch.
// Validate strictly — reject NaN/negative/huge, enforce the writeMode enum.
const nonNegInt = z.number().int().min(0);
const PatchSchema = z
  .object({
    writeMode: z.enum(["off", "observe", "tier_a", "all"]).optional(),
    emergencyStop: z.boolean().optional(),
    maxAccountDailySpendCents: nonNegInt.max(1_000_000_00).optional(), // ≤ $1,000,000/day sanity ceiling
    maxActionBudgetDeltaCents: nonNegInt.max(1_000_000_00).optional(),
    maxActionBudgetDeltaPct: z.number().min(0).max(1000).optional(),
    minMetricFreshnessMinutes: nonNegInt.max(10080).optional(), // ≤ 1 week
    targetCpaCents: nonNegInt.max(1_000_000_00).optional(),
    targetRoas: z.number().min(0).max(1000).optional(),
  })
  .strict();

const AgencyPatchSchema = z.object({ emergencyStop: z.boolean() }).strict();

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => null);
  const agencyScope = new URL(req.url).searchParams.get("scope") === "agency";
  const parsed = (agencyScope ? AgencyPatchSchema : PatchSchema).safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid control patch", issues: parsed.error.issues }, { status: 400 });
  try {
    const control = agencyScope
      ? await setAgencyControl({ emergencyStop: parsed.data.emergencyStop })
      : await setControl(resolveClientId(req), parsed.data);
    return NextResponse.json({ control });
  } catch (e) {
    console.error("[control] PATCH failed:", e);
    if (isInvalidClientIdError(e)) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: "internal error" }, { status: 503 });
  }
}
