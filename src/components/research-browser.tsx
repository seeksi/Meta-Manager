"use client";
// Module 7 — competitor research browser. docs/PRODUCT_SPEC.md §7.
import { useCallback, useEffect, useState } from "react";

interface Creative {
  id: string; advertiser: string; body: string | null; mediaUrl: string | null;
  startedRunning: string | null; daysRunning: number | null; tags: unknown; longRunner: boolean;
}

export function ResearchBrowser() {
  const [items, setItems] = useState<Creative[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [advertiser, setAdvertiser] = useState("");
  const [body, setBody] = useState("");
  const [started, setStarted] = useState("");
  const [search, setSearch] = useState("");
  const [country, setCountry] = useState("US");
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetch("/api/research").then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setItems(d.creatives ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function add() {
    await fetch("/api/research", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ advertiser, body, startedRunning: started || undefined }),
    });
    setAdvertiser(""); setBody(""); setStarted("");
    load();
  }

  async function fetchLibrary() {
    setFetching(true); setFetchMsg(null);
    try {
      const res = await fetch("/api/research/fetch", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ searchTerms: search, country }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "request failed");
      setFetchMsg(`Fetched ${d.fetched}, added ${d.added}.`);
      load();
    } catch (e) {
      setFetchMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  }
  async function tag(id: string, current: string[]) {
    const input = prompt("Tags (comma-separated):", current.join(", "));
    if (input === null) return;
    await fetch(`/api/research/${id}/tags`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: input.split(",").map((s) => s.trim()).filter(Boolean) }),
    });
    load();
  }

  return (
    <div className="space-y-4">
      {error && <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm">Database not connected ({error}).</div>}

      <div className="rounded-md border border-black/10 dark:border-white/10 p-3">
        <div className="mb-1 text-sm font-medium">Search the Meta Ad Library</div>
        <div className="flex flex-wrap items-end gap-2">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search terms (brand, keyword)"
            className="min-w-56 flex-1 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-blue-500" />
          <input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} placeholder="US" maxLength={2}
            className="w-16 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm uppercase outline-none focus:border-blue-500" />
          <button onClick={fetchLibrary} disabled={fetching || !search}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {fetching ? "Fetching…" : "Fetch"}
          </button>
        </div>
        {fetchMsg && <div className="mt-2 text-xs text-black/60 dark:text-white/60">{fetchMsg}</div>}
        <p className="mt-1 text-xs text-black/40 dark:text-white/40">
          Ad Library coverage varies by country — many regions expose only political/issue ads via API.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <input value={advertiser} onChange={(e) => setAdvertiser(e.target.value)} placeholder="Advertiser (manual add)"
          className="rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-blue-500" />
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Ad copy / hook"
          className="min-w-56 flex-1 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-blue-500" />
        <input type="date" value={started} onChange={(e) => setStarted(e.target.value)}
          className="rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-blue-500" />
        <button onClick={add} disabled={!advertiser}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">Save</button>
      </div>
      <p className="text-xs text-black/40 dark:text-white/40">
        Ingest from the Meta Ad Library / Apify actor (meta-creatives-research). For inspiration, not copying.
      </p>

      {items.length === 0 ? (
        <p className="text-sm text-black/60 dark:text-white/60">No competitor creatives yet.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((c) => {
            const tags = Array.isArray(c.tags) ? (c.tags as string[]) : [];
            return (
              <div key={c.id} className="rounded-lg border border-black/10 dark:border-white/10 p-3 text-sm space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{c.advertiser}</span>
                  {c.longRunner && (
                    <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-800 dark:bg-green-950/40 dark:text-green-300">
                      long-runner {c.daysRunning}d
                    </span>
                  )}
                </div>
                {c.body && <p className="text-black/70 dark:text-white/70">{c.body}</p>}
                <div className="flex flex-wrap gap-1">
                  {tags.map((t) => <span key={t} className="rounded bg-black/5 dark:bg-white/10 px-1.5 py-0.5 text-xs">{t}</span>)}
                  <button onClick={() => tag(c.id, tags)} className="text-xs text-blue-600 hover:underline">+ tag</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
