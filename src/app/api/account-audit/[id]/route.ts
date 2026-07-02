import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditRuns } from "@/db/schema";
import { operatorIdFromRequest } from "@/lib/auth";
import { clientOwnedBy } from "@/lib/clients";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const operatorId = await operatorIdFromRequest(req);
  if (!operatorId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const id = (await params).id;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid run id" }, { status: 400 });
  }

  // Look the run up by id, then authorize by the run's own client — never a request-defaulted
  // client (which would 404 a run the operator legitimately owns under a non-bootstrap client).
  const [run] = await getDb().select().from(auditRuns).where(eq(auditRuns.id, id)).limit(1);
  if (!run || !(await clientOwnedBy(operatorId, run.clientId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ run });
}
