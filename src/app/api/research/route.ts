import { NextResponse } from "next/server";
import { ingestCompetitors, listCompetitors, type CompetitorInput } from "@/lib/research";

export async function GET() {
  try {
    return NextResponse.json({ creatives: await listCompetitors() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const items: CompetitorInput[] = Array.isArray(body) ? body : [body];
    if (!items.every((i) => i?.advertiser)) {
      return NextResponse.json({ error: "each item needs an advertiser" }, { status: 400 });
    }
    return NextResponse.json(await ingestCompetitors(items));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
