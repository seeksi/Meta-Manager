import { NextResponse } from "next/server";
import { funnel } from "@/lib/leads";

export async function GET() {
  try {
    return NextResponse.json(await funnel());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
