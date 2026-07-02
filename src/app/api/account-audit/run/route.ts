import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { auditRuns } from "@/db/schema";
import { operatorIdFromRequest } from "@/lib/auth";
import { clientOwnedBy, isInvalidClientIdError, resolveClientId, validateClientId } from "@/lib/clients";
import { AUDIT_ENGINE_VERSION, runAudit, type AuditInputs } from "@/lib/audit-engine";

export const dynamic = "force-dynamic";

const AuditInputsSchema = z.object({
  capiEnabled: z.boolean().optional(),
  emqPurchase: z.number().min(0).max(10).optional(),
  leadEventFiring: z.boolean().optional(),
  dedupRate: z.number().min(0).max(1).optional(),
}).strict();

const RunBodySchema = z.object({
  clientId: z.string().uuid().optional(),
  inputs: AuditInputsSchema.optional(),
}).strict();

export async function POST(req: Request) {
  const operatorId = await operatorIdFromRequest(req);
  if (!operatorId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const raw = await req.json().catch(() => ({}));
  const parsed = RunBodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "invalid audit request", issues: parsed.error.issues }, { status: 400 });

  let clientId: string;
  try {
    clientId = parsed.data.clientId ? validateClientId(parsed.data.clientId) : resolveClientId(req);
  } catch (e) {
    if (isInvalidClientIdError(e)) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
  if (!(await clientOwnedBy(operatorId, clientId))) return NextResponse.json({ error: "not found" }, { status: 404 });

  const inputs: AuditInputs | undefined = parsed.data.inputs;
  const startedAt = new Date();
  try {
    const report = await runAudit(clientId, inputs);
    const [run] = await getDb().insert(auditRuns).values({
      clientId,
      status: "complete",
      trigger: "manual",
      score: report.score,
      engineVersion: report.version,
      summary: report.summary,
      inputs: inputs ?? null,
      findings: report.findings,
      startedAt,
      finishedAt: new Date(),
    }).returning();
    return NextResponse.json({ run });
  } catch (e) {
    console.error("[account-audit] run failed:", e);
    const message = e instanceof Error ? e.message : String(e);
    const [run] = await getDb().insert(auditRuns).values({
      clientId,
      status: "failed",
      trigger: "manual",
      score: null,
      engineVersion: AUDIT_ENGINE_VERSION,
      summary: { error: message },
      inputs: inputs ?? null,
      findings: [],
      startedAt,
      finishedAt: new Date(),
    }).returning();
    return NextResponse.json({ run });
  }
}
