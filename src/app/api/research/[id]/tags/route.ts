import { NextResponse } from "next/server";
import { tagCreative } from "@/lib/research";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { tags } = (await req.json()) as { tags: string[] };
    return NextResponse.json({ creative: await tagCreative(id, tags) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
