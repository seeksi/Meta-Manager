import { NextResponse } from "next/server";
import { proposeAction, type ProposeInput } from "@/lib/automation";

export async function POST(req: Request) {
  try {
    const input = (await req.json()) as ProposeInput;
    const action = await proposeAction(input);
    return NextResponse.json({ action });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
