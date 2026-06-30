import { NextResponse } from "next/server";
import { listQueue } from "@/lib/automation";
import { resolveClientId } from "@/lib/clients";

export async function GET(req: Request) {
  try {
    return NextResponse.json({ queue: await listQueue(resolveClientId(req)) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
