import { NextResponse } from "next/server";
import { listAudit } from "@/lib/automation";

export async function GET() {
  try {
    return NextResponse.json({ events: await listAudit() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
