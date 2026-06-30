import { NextResponse } from "next/server";
import { approveAction } from "@/lib/automation";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    // ponytail: by-PK mutation, no client-ownership check — safe under M1's single trusted
    // operator; WS-3 (per-operator auth) must assert the action's clientId === resolveClientId(req)
    // to prevent cross-client IDOR. See api/experiments/[id] for the scoped pattern.
    return NextResponse.json({ action: await approveAction(id) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
