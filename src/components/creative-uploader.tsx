"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function CreativeUploader() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/creatives", { method: "POST", body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "upload failed");
      setMsg(data.deduped ? "Already in library (deduped)." : "Uploaded.");
      router.refresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  return (
    <div className="flex items-center gap-3">
      <label className="cursor-pointer rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
        {busy ? "Uploading…" : "Upload creative"}
        <input type="file" accept="image/*,video/*" onChange={onChange} disabled={busy} className="hidden" />
      </label>
      {msg && <span className="text-sm text-black/60 dark:text-white/60">{msg}</span>}
    </div>
  );
}
