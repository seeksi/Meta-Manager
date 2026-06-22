import { NextResponse } from "next/server";
import { createAd, type AdInput } from "@/lib/creatives";

export async function POST(req: Request) {
  try {
    const input = (await req.json()) as AdInput;
    if (!input.creativeId) {
      return NextResponse.json({ error: "creativeId is required" }, { status: 400 });
    }
    return NextResponse.json(await createAd(input));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
