import { NextResponse } from "next/server";
import { listQueue } from "@/lib/automation";

export async function GET() {
  try {
    return NextResponse.json({ queue: await listQueue() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
