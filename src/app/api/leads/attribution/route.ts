import { NextResponse } from "next/server";
import { cplByCampaign } from "@/lib/leads";

export async function GET() {
  try {
    return NextResponse.json({ rows: await cplByCampaign() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
