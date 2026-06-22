import { NextResponse } from "next/server";
import { detectFatigue } from "@/lib/fatigue";

export async function GET() {
  try {
    return NextResponse.json({ signals: await detectFatigue() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
