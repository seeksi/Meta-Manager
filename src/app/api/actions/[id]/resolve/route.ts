// Operator resolves an `uncertain` write after verifying its real state in Meta.
// Body: { applied: boolean } — did the change actually take effect on Meta?
import { resolveUncertain } from "@/lib/automation";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { applied } = await req.json();
    const row = await resolveUncertain(id, Boolean(applied));
    return Response.json({ ok: true, action: row });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
