import { NextResponse } from "next/server";
import { detectFatigue } from "@/lib/fatigue";
import { resolveClientId } from "@/lib/clients";

export async function GET(req: Request) {
  try {
    return NextResponse.json({ signals: await detectFatigue(resolveClientId(req)) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
