import { NextResponse } from "next/server";
import { isInvalidClientIdError } from "@/lib/clients";
import { verifyClient } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    void req;
    const { id } = await params;
    const r = await verifyClient(id);
    return NextResponse.json(r);
  } catch (e) {
    if (isInvalidClientIdError(e)) return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
    throw e;
  }
}
