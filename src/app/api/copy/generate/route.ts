import { NextResponse } from "next/server";
import { generateAdCopy, type CopyBrief } from "@/lib/copy";

export async function POST(req: Request) {
  try {
    const brief = (await req.json()) as CopyBrief;
    if (!brief.product?.trim()) {
      return NextResponse.json({ error: "product is required" }, { status: 400 });
    }
    return NextResponse.json({ variants: await generateAdCopy(brief) });
  } catch (e) {
    // Common cause: AI_GATEWAY_API_KEY not set. Surface clearly.
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
