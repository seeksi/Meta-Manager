import { NextResponse } from "next/server";
import { captureLead, listLeads, type CaptureInput } from "@/lib/leads";
import { resolveClientId } from "@/lib/clients";

export async function GET(req: Request) {
  try {
    return NextResponse.json({ leads: await listLeads(resolveClientId(req)) });
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
    return NextResponse.json(await captureLead(resolveClientId(req), input));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
