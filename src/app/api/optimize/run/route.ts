import { NextResponse } from "next/server";
import { runOptimization } from "@/lib/optimizer";

export async function POST() {
  try {
    return NextResponse.json(await runOptimization());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
