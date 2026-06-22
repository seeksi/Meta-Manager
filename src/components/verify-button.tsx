"use client";
import { useState } from "react";

export function VerifyButton() {
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify() {
    setBusy(true);
    try {
      const res = await fetch("/api/connection/verify", { method: "POST" });
      const data = await res.json();
      setOk(data.ok);
      setMsg(data.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button onClick={verify} disabled={busy}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
        {busy ? "Verifying…" : "Verify connection"}
      </button>
      {msg && (
        <div className={`text-sm ${ok ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}`}>
          {ok ? "✓ " : "⚠ "}{msg}
        </div>
      )}
    </div>
  );
}
