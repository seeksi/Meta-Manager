import { NextResponse } from "next/server";
import { createExperiment, listExperiments, type ExperimentInput } from "@/lib/experiments";
import { resolveClientId } from "@/lib/clients";

export async function GET(req: Request) {
  try {
    return NextResponse.json({ experiments: await listExperiments(resolveClientId(req)) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const input = (await req.json()) as ExperimentInput;
    if (!input.name || !input.variantAId || !input.variantBId) {
      return NextResponse.json({ error: "name, variantAId, variantBId required" }, { status: 400 });
    }
    return NextResponse.json({ experiment: await createExperiment(resolveClientId(req), input) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
