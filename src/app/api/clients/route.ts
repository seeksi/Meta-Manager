import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { automationControl, clients } from "@/db/schema";
import { createClient } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

const ACCOUNT_RE = /^(?:act_)?[0-9]{5,20}$/;
const NODE_RE = /^[0-9]{5,20}$/;

const ClientCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    metaAccountId: z.string().regex(ACCOUNT_RE, "ad account id must be numeric (optionally act_-prefixed)"),
    pageId: z.string().regex(NODE_RE, "page id must be numeric").optional(),
    pixelId: z.string().regex(NODE_RE, "pixel id must be numeric").optional(),
  })
  .strict();

export async function GET() {
  const rows = await getDb()
    .select({
      id: clients.id,
      name: clients.name,
      status: clients.status,
      verifyState: clients.verifyState,
      metaAccountId: clients.metaAccountId,
      pageId: clients.pageId,
      pixelId: clients.pixelId,
      writeMode: automationControl.writeMode,
    })
    .from(clients)
    .leftJoin(automationControl, eq(automationControl.clientId, clients.id));

  return NextResponse.json({ clients: rows });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = ClientCreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  const client = await createClient(parsed.data);
  return NextResponse.json({ ok: true, client }, { status: 201 });
}
