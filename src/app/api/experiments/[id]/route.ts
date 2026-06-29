import { NextResponse } from "next/server";
import { getExperimentResult } from "@/lib/experiments";
import { resolveClientId } from "@/lib/clients";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const data = await getExperimentResult(resolveClientId(req), id);
    if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
