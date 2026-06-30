import { NextResponse } from "next/server";
import { z } from "zod";
import { checkCredentials, sessionCookieOptions, SESSION_COOKIE_NAME, signSession } from "@/lib/auth";
import { BOOTSTRAP_OPERATOR_ID } from "@/lib/clients";

export const dynamic = "force-dynamic";

const Body = z.object({
  username: z.string().max(200),
  password: z.string().max(500),
}).strict();

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "invalid credentials" }, { status: 401 });
  const ok = await checkCredentials(parsed.data.username, parsed.data.password);
  if (!ok) return NextResponse.json({ ok: false, error: "invalid credentials" }, { status: 401 });

  const token = await signSession(BOOTSTRAP_OPERATOR_ID);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());
  return res;
}
