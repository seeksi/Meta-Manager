import { NextResponse } from "next/server";
import { engageKill, engageAgencyKill } from "@/lib/automation";
import { isInvalidClientIdError, resolveClientId } from "@/lib/clients";

// Panic-button default is agency-wide: an operator who omits scope must stop every client.
// Single-client stops require explicit `?scope=client` plus the resolved client id.
export async function POST(req: Request) {
  try {
    const scope = new URL(req.url).searchParams.get("scope");
    if (scope === "client") {
      const control = await engageKill(resolveClientId(req));
      return NextResponse.json({ ok: true, scope: "client", control });
    }
    const control = await engageAgencyKill();
    return NextResponse.json({ ok: true, scope: "agency", control });
  } catch (e) {
    if (isInvalidClientIdError(e)) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }
}
