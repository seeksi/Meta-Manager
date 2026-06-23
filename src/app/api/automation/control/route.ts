import { NextResponse } from "next/server";
import { z } from "zod";
import { getControl, ensureControl, setControl } from "@/lib/automation";

export async function GET() {
  try {
    const control = (await getControl()) ?? (await ensureControl());
    return NextResponse.json({ control });
  } catch (e) {
    console.error("[control] GET failed:", e);
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

export async function PATCH(req: Request) {
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid control patch", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    const control = await setControl(parsed.data);
    return NextResponse.json({ control });
  } catch (e) {
    console.error("[control] PATCH failed:", e);
    return NextResponse.json({ error: "internal error" }, { status: 503 });
  }
}
