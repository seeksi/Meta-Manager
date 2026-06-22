import { NextResponse } from "next/server";
import { getControl, ensureControl, setControl, type ControlPatch } from "@/lib/automation";

export async function GET() {
  try {
    const control = (await getControl()) ?? (await ensureControl());
    return NextResponse.json({ control });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}

export async function PATCH(req: Request) {
  try {
    const patch = (await req.json()) as ControlPatch;
    const control = await setControl(patch);
    return NextResponse.json({ control });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
