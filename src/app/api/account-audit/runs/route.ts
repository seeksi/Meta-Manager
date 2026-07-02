import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditRuns } from "@/db/schema";
import { operatorIdFromRequest } from "@/lib/auth";
import { clientOwnedBy, isInvalidClientIdError, resolveClientId } from "@/lib/clients";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const operatorId = await operatorIdFromRequest(req);
  if (!operatorId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let clientId: string;
  try {
    clientId = resolveClientId(req);
  } catch (e) {
    if (isInvalidClientIdError(e)) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
  if (!(await clientOwnedBy(operatorId, clientId))) return NextResponse.json({ error: "not found" }, { status: 404 });

  const runs = await getDb().select().from(auditRuns)
    .where(eq(auditRuns.clientId, clientId))
    .orderBy(desc(auditRuns.startedAt))
    .limit(50);
  return NextResponse.json({ runs });
}
