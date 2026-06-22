import { NextResponse } from "next/server";
import { previewAction, type ProposeInput } from "@/lib/automation";

export async function POST(req: Request) {
  try {
    const input = (await req.json()) as ProposeInput;
    return NextResponse.json(await previewAction(input));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
