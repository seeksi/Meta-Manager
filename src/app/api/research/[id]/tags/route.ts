import { NextResponse } from "next/server";
import { tagCreative } from "@/lib/research";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { tags } = (await req.json()) as { tags: string[] };
    // ponytail: by-PK mutation, no client-ownership check — safe under M1's single trusted
    // operator; WS-3 (per-operator auth) must assert the row's clientId === resolveClientId(req)
    // to prevent cross-client IDOR. See api/experiments/[id] for the scoped pattern.
    return NextResponse.json({ creative: await tagCreative(id, tags) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
