// Settings → Setup: read presence / save Meta credential keys to .env. Local desktop,
// single operator, localhost only — no auth layer. Hosted deploys set HOSTED=1 to
// disable writes here; ponytail: G4 adds full operator auth before broad exposure.
import { NextResponse } from "next/server";
import { z } from "zod";
import { AGENCY_TOKEN_ENV } from "@/lib/clients";
import { envPresence, envWritesAllowed, writeEnvKeys } from "@/lib/env-file";

export const dynamic = "force-dynamic";

// Allowlist — only these keys may be written. Prevents writing arbitrary env.
const KEYS = [
  "META_API_VERSION",
  "META_APP_ID",
  "META_APP_SECRET",
  AGENCY_TOKEN_ENV,
] as const;

const Body = z
  .object(Object.fromEntries(KEYS.map((k) => [k, z.string().max(800).optional()])))
  .strict();

export function GET() {
  return NextResponse.json({ present: envPresence(KEYS), editable: envWritesAllowed() });
}

export async function POST(req: Request) {
  if (!envWritesAllowed()) {
    return NextResponse.json(
      { ok: false, error: "env writes disabled on hosted deploy; set secrets via the host secret store" },
      { status: 403 },
    );
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }
  let written: string[];
  try {
    written = writeEnvKeys(parsed.data);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "write failed" },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true, written, present: envPresence(KEYS) });
}
