import { NextResponse } from "next/server";
import { previewAction, ProposeInputSchema } from "@/lib/automation";
import { isInvalidClientIdError, resolveClientId } from "@/lib/clients";

export async function POST(req: Request) {
  const raw = await req.json().catch(() => ({}));
  let clientId: string;
  try {
    clientId = raw?.clientId ?? resolveClientId(req);
  } catch (e) {
    if (isInvalidClientIdError(e)) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
  const parsed = ProposeInputSchema.safeParse({ ...raw, clientId });
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
