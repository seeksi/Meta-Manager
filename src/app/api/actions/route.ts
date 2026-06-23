import { NextResponse } from "next/server";
import { proposeAction, ProposeInputSchema } from "@/lib/automation";

export async function POST(req: Request) {
  const parsed = ProposeInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid action", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    const action = await proposeAction(parsed.data);
    return NextResponse.json({ action });
  } catch (e) {
    console.error("[actions] propose failed:", e);
    return NextResponse.json({ error: "internal error" }, { status: 503 });
  }
}
