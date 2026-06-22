import { NextResponse } from "next/server";
import { createExperiment, listExperiments, type ExperimentInput } from "@/lib/experiments";

export async function GET() {
  try {
    return NextResponse.json({ experiments: await listExperiments() });
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
    return NextResponse.json({ experiment: await createExperiment(input) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
