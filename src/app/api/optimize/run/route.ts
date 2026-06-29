import { NextResponse } from "next/server";
import { runOptimization } from "@/lib/optimizer";
import { resolveClientId } from "@/lib/clients";

export async function POST(req: Request) {
  try {
    return NextResponse.json(await runOptimization(resolveClientId(req)));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
