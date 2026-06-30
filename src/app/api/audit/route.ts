import { NextResponse } from "next/server";
import { listAudit } from "@/lib/automation";
import { isInvalidClientIdError, optionalClientIdFromSearchParams } from "@/lib/clients";

// Agency-wide audit feed by default (deliberate cross-client read). Pass `?clientId=` to scope
// to one client.
export async function GET(req: Request) {
  try {
    const clientId = optionalClientIdFromSearchParams(new URL(req.url).searchParams);
    return NextResponse.json({ events: await listAudit(clientId) });
  } catch (e) {
    if (isInvalidClientIdError(e)) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
