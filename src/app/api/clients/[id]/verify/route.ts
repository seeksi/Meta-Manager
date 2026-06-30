import { NextResponse } from "next/server";
import { operatorIdFromRequest } from "@/lib/auth";
import { assertClientOwnedBy, isClientNotOwnedError, isInvalidClientIdError, validateClientId } from "@/lib/clients";
import { verifyClient } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const operatorId = await operatorIdFromRequest(req);
    if (!operatorId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    const { id } = await params;
    validateClientId(id);
    await assertClientOwnedBy(operatorId, id);
    const r = await verifyClient(id);
    return NextResponse.json(r);
  } catch (e) {
    if (isInvalidClientIdError(e)) return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
    if (isClientNotOwnedError(e)) return NextResponse.json({ ok: false, error: e.message }, { status: 403 });
    throw e;
  }
}
