import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditRuns } from "@/db/schema";
import { operatorIdFromRequest } from "@/lib/auth";
import { clientOwnedBy, isInvalidClientIdError, resolveClientId, validateClientId } from "@/lib/clients";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const operatorId = await operatorIdFromRequest(req);
  if (!operatorId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let clientId: string;
  let id: string;
  try {
    clientId = resolveClientId(req);
    id = validateClientId((await params).id);
  } catch (e) {
    if (isInvalidClientIdError(e)) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
  if (!(await clientOwnedBy(operatorId, clientId))) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [run] = await getDb().select().from(auditRuns)
    .where(and(eq(auditRuns.id, id), eq(auditRuns.clientId, clientId)))
    .limit(1);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ run });
}
