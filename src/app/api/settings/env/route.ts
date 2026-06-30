// Settings → Setup: read presence / save Meta credential keys to .env. Local desktop,
// single operator, localhost only — no auth layer. ponytail: if this server is ever
// exposed beyond loopback, gate this route with an operator token.
import { NextResponse } from "next/server";
import { z } from "zod";
import { AGENCY_TOKEN_ENV } from "@/lib/clients";
import { writeEnvKeys, envPresence } from "@/lib/env-file";

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
  return NextResponse.json({ present: envPresence(KEYS) });
}

export async function POST(req: Request) {
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
