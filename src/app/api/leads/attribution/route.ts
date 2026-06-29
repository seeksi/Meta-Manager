import { NextResponse } from "next/server";
import { cplByCampaign } from "@/lib/leads";
import { resolveClientId } from "@/lib/clients";

export async function GET(req: Request) {
  try {
    return NextResponse.json({ rows: await cplByCampaign(resolveClientId(req)) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
