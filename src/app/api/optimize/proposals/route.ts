import { NextResponse } from "next/server";
import { listProposals } from "@/lib/optimizer";
import { resolveClientId } from "@/lib/clients";

export async function GET(req: Request) {
  try {
    return NextResponse.json({ proposals: await listProposals(resolveClientId(req)) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
