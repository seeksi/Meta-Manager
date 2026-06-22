"use client";
// Module 4 — Ad assembly. Pick a creative, attach copy/CTA/destination, queue launch
// (Tier B → approval queue). docs/PRODUCT_SPEC.md §4.
import { useEffect, useState } from "react";

interface Creative { id: string; blobUrl: string; type: string }

export function AdAssembler() {
  const [creatives, setCreatives] = useState<Creative[]>([]);
  const [creativeId, setCreativeId] = useState("");
  const [headline, setHeadline] = useState("");
  const [primaryText, setPrimaryText] = useState("");
  const [cta, setCta] = useState("Learn More");
  const [url, setUrl] = useState("");
  const [adsetId, setAdsetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/creatives")
      .then((r) => r.json())
      .then((d) => setCreatives(d.creatives ?? []))
      .catch(() => setCreatives([]));
  }, []);

  async function queueLaunch() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/ads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          creativeId,
          copy: { headline, primaryText },
          cta,
          destinationUrl: url,
          adsetId,
          launch: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "request failed");
      setMsg(`Ad created. Action status: ${data.action?.status ?? "draft"} — review in Automation → Approval queue.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (creatives.length === 0) {
    return <p className="text-sm text-black/60 dark:text-white/60">Upload a creative first (Creatives tab).</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {creatives.map((c) => (
          <button
            key={c.id}
            onClick={() => setCreativeId(c.id)}
            className={`overflow-hidden rounded-md border-2 ${creativeId === c.id ? "border-blue-500" : "border-transparent"}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={c.blobUrl} alt="" className="h-16 w-16 object-cover" />
          </button>
        ))}
      </div>
      <input value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="Headline"
        className="w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-blue-500" />
      <textarea value={primaryText} onChange={(e) => setPrimaryText(e.target.value)} placeholder="Primary text" rows={2}
        className="w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-blue-500" />
      <div className="grid gap-2 sm:grid-cols-2">
        <input value={cta} onChange={(e) => setCta(e.target.value)} placeholder="CTA"
          className="rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-blue-500" />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Destination URL"
          className="rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-blue-500" />
      </div>
      <input value={adsetId} onChange={(e) => setAdsetId(e.target.value)} placeholder="Existing ad set ID (e.g. 120xxxxxxxxxxxxxx)"
        className="w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-blue-500" />
      <button onClick={queueLaunch} disabled={busy || !creativeId || !adsetId || !url}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
        {busy ? "Queuing…" : "Queue launch (Tier B)"}
      </button>
      <p className="text-xs text-black/40 dark:text-white/40">
        The ad is created <strong>paused</strong> under your existing ad set after approval. Unpause it (Tier B) when ready to spend.
      </p>
      {msg && <div className="text-sm text-black/70 dark:text-white/70">{msg}</div>}
    </div>
  );
}
