import { NextResponse } from "next/server";
import { ingestCompetitors, listCompetitors, type CompetitorInput } from "@/lib/research";
import { resolveClientId } from "@/lib/clients";

export async function GET(req: Request) {
  try {
    return NextResponse.json({ creatives: await listCompetitors(resolveClientId(req)) });
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
    return NextResponse.json(await ingestCompetitors(resolveClientId(req), items));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
