import { NextResponse } from "next/server";
import { triggerNurture } from "@/lib/leads";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json(await triggerNurture(id));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
