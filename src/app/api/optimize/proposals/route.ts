import { NextResponse } from "next/server";
import { listProposals } from "@/lib/optimizer";

export async function GET() {
  try {
    return NextResponse.json({ proposals: await listProposals() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
