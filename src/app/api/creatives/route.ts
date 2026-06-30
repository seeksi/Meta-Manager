import { NextResponse } from "next/server";
import { uploadCreative, listCreatives } from "@/lib/creatives";
import { resolveClientId } from "@/lib/clients";

export async function GET(req: Request) {
  try {
    return NextResponse.json({ creatives: await listCreatives(resolveClientId(req)) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await uploadCreative(resolveClientId(req), { name: file.name, bytes, contentType: file.type });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
