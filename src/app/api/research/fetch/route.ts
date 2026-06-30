// Pull competitor ads live from the Meta Ad Library and ingest them.
// Body: { searchTerms: string, country?: string }
import { fetchAdLibrary } from "@/lib/meta/client";
import { ingestCompetitors } from "@/lib/research";
import { resolveClientId, activeClientContext } from "@/lib/clients";

export async function POST(req: Request) {
  try {
    const { searchTerms, country } = await req.json();
    if (!searchTerms) return Response.json({ error: "searchTerms required" }, { status: 400 });
    const clientId = resolveClientId(req);
    const ctx = await activeClientContext(clientId);
    const items = await fetchAdLibrary(ctx, { searchTerms, countries: country ? [country] : undefined });
    const res = await ingestCompetitors(clientId, items);
    return Response.json({ ok: true, fetched: items.length, ...res });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
