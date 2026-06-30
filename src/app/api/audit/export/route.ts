import { listAudit } from "@/lib/automation";
import { isInvalidClientIdError, optionalClientIdFromSearchParams } from "@/lib/clients";
import { toCsv } from "@/lib/csv";

// Agency-wide audit export by default (deliberate cross-client read). Pass `?clientId=` to scope.
export async function GET(req: Request) {
  try {
    const clientId = optionalClientIdFromSearchParams(new URL(req.url).searchParams);
    const events = await listAudit(clientId, 1000);
    const csv = toCsv(
      ["created_at", "actor", "event_type", "subject_id", "reason"],
      events.map((e) => [
        new Date(e.createdAt).toISOString(), e.actor, e.eventType, e.subjectId, e.reason,
      ]),
    );
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (e) {
    if (isInvalidClientIdError(e)) return new Response(e.message, { status: 400 });
    return new Response(String(e), { status: 503 });
  }
}
