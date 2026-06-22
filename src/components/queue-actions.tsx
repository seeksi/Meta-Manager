"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function QueueActions({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function act(kind: "approve" | "reject") {
    setBusy(true);
    try {
      await fetch(`/api/actions/${id}/${kind}`, { method: "POST" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex gap-2">
      <button
        disabled={busy}
        onClick={() => act("approve")}
        className="rounded-md bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
      >
        Approve
      </button>
      <button
        disabled={busy}
        onClick={() => act("reject")}
        className="rounded-md border border-black/15 dark:border-white/15 px-2.5 py-1 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
      >
        Reject
      </button>
    </div>
  );
}
