// Pull competitor ads live from the Meta Ad Library and ingest them.
// Body: { searchTerms: string, country?: string }
import { fetchAdLibrary } from "@/lib/meta/client";
import { ingestCompetitors } from "@/lib/research";

export async function POST(req: Request) {
  try {
    const { searchTerms, country } = await req.json();
    if (!searchTerms) return Response.json({ error: "searchTerms required" }, { status: 400 });
    const items = await fetchAdLibrary({ searchTerms, countries: country ? [country] : undefined });
    const res = await ingestCompetitors(items);
    return Response.json({ ok: true, fetched: items.length, ...res });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
