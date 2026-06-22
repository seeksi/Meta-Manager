import { NextResponse } from "next/server";
import { setStage, type Stage, STAGES } from "@/lib/leads";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { stage } = (await req.json()) as { stage: Stage };
    if (!STAGES.includes(stage)) {
      return NextResponse.json({ error: "invalid stage" }, { status: 400 });
    }
    return NextResponse.json({ lead: await setStage(id, stage) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
