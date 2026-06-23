import { NextResponse } from "next/server";
import { previewAction, ProposeInputSchema } from "@/lib/automation";

export async function POST(req: Request) {
  const parsed = ProposeInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid action", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    return NextResponse.json(await previewAction(parsed.data));
  } catch (e) {
    console.error("[actions] preview failed:", e);
    return NextResponse.json({ error: "internal error" }, { status: 503 });
  }
}
