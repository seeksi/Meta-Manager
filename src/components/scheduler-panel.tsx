"use client";
// Scheduler status + on-demand triggers. Desktop automation runs only while the app is open,
// so the operator can see last/next runs and force one now. GET/POST /api/scheduler.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { SchedulerStatus } from "@/lib/scheduler";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

export function SchedulerPanel() {
  const [s, setS] = useState<SchedulerStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const router = useRouter();

  function load() {
    fetch("/api/scheduler").then((r) => r.json())
      .then((d) => { if (d.status) setS(d.status); })
      .catch(() => {});
  }
  useEffect(() => { load(); }, []);

  async function run(job: "poll" | "optimize") {
    setBusy(job);
    try {
      await fetch("/api/scheduler", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job }),
      });
      load();
      router.refresh(); // surface freshly ingested metrics / new proposals
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-black/70 dark:text-white/70">
        <span className="text-black/50 dark:text-white/50">Status</span>
        <span>{s?.started ? (s.busy ? `running ${s.busy}…` : "active") : "not started"}</span>
        <span className="text-black/50 dark:text-white/50">Last insights poll</span>
        <span className="tabular-nums">{fmt(s?.lastPollAt ?? null)}</span>
        <span className="text-black/50 dark:text-white/50">Next optimizer run</span>
        <span className="tabular-nums">{fmt(s?.nextOptimizeAt ?? null)}</span>
        <span className="text-black/50 dark:text-white/50">Last optimizer run</span>
        <span className="tabular-nums">{fmt(s?.lastOptimizeAt ?? null)}</span>
      </div>

      <div className="flex gap-2">
        <button disabled={!!busy} onClick={() => run("poll")}
          className="rounded-md border border-black/15 dark:border-white/15 px-2.5 py-1 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50">
          {busy === "poll" ? "Polling…" : "Poll now"}
        </button>
        <button disabled={!!busy} onClick={() => run("optimize")}
          className="rounded-md border border-black/15 dark:border-white/15 px-2.5 py-1 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50">
          {busy === "optimize" ? "Running…" : "Run optimizer now"}
        </button>
      </div>

      <p className="text-xs text-black/40 dark:text-white/40">
        Automation runs only while this app is open. The native Meta account spend cap is the 24/7 backstop.
      </p>
    </div>
  );
}
