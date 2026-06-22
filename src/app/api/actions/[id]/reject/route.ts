import { NextResponse } from "next/server";
import { rejectAction } from "@/lib/automation";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json({ action: await rejectAction(id) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
