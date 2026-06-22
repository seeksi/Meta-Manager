import { listAudit } from "@/lib/automation";
import { toCsv } from "@/lib/csv";

export async function GET() {
  try {
    const events = await listAudit(1000);
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
    return new Response(String(e), { status: 503 });
  }
}
