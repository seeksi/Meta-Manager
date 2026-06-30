import { NextResponse } from "next/server";
import { verifyConnection } from "@/lib/connection";
import { isInvalidClientIdError, resolveClientId } from "@/lib/clients";

export async function POST(req: Request) {
  try {
    return NextResponse.json(await verifyConnection(resolveClientId(req)));
  } catch (e) {
    if (isInvalidClientIdError(e)) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
