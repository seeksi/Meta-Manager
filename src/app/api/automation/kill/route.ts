import { NextResponse } from "next/server";
import { engageKill } from "@/lib/automation";

export async function POST() {
  try {
    const control = await engageKill();
    return NextResponse.json({ ok: true, control });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
