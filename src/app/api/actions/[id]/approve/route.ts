import { NextResponse } from "next/server";
import { approveAction } from "@/lib/automation";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json({ action: await approveAction(id) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
