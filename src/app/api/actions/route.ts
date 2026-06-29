import { NextResponse } from "next/server";
import { proposeAction, ProposeInputSchema } from "@/lib/automation";
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
  // clientId may come in the body; otherwise resolve from query/header (defaults to bootstrap).
  const parsed = ProposeInputSchema.safeParse({ ...raw, clientId });
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
