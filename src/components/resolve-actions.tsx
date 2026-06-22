"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** Resolve an uncertain write after the operator verifies its real state in Meta. */
export function ResolveActions({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function resolve(applied: boolean) {
    setBusy(true);
    try {
      await fetch(`/api/actions/${id}/resolve`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ applied }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex gap-2">
      <button disabled={busy} onClick={() => resolve(true)}
        className="rounded-md border border-black/15 dark:border-white/15 px-2.5 py-1 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50">
        Applied
      </button>
      <button disabled={busy} onClick={() => resolve(false)}
        className="rounded-md border border-black/15 dark:border-white/15 px-2.5 py-1 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50">
        Not applied
      </button>
    </div>
  );
}
