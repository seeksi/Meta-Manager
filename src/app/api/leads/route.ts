import { NextResponse } from "next/server";
import { captureLead, listLeads, type CaptureInput } from "@/lib/leads";

export async function GET() {
  try {
    return NextResponse.json({ leads: await listLeads() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const input = (await req.json()) as CaptureInput;
    if (!input.source && !input.attributes) {
      return NextResponse.json({ error: "source or attributes required" }, { status: 400 });
    }
    return NextResponse.json(await captureLead(input));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
