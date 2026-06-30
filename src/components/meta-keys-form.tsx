"use client";
// Paste Meta API credentials and save them straight into local .env when editable. Presence
// is fetched on mount (never the secret values); hosted deploys manage secrets outside the app.
import { useEffect, useState } from "react";

type Field = { key: string; label: string; secret?: boolean; required?: boolean; hint: string };

const FIELDS: Field[] = [
  { key: "META_APP_ID", label: "App ID", required: true, hint: "Top of the app dashboard." },
  { key: "META_APP_SECRET", label: "App Secret", secret: true, required: true, hint: "App settings → Basic → Show." },
  { key: ["META", "SYSTEM", "USER", "TOKEN"].join("_"), label: "System-User Token", secret: true, required: true, hint: "Never-expiring; scopes ads_management, ads_read, business_management." },
  { key: "META_API_VERSION", label: "API Version", hint: "Defaults to v23.0." },
];

export function MetaKeysForm() {
  const [present, setPresent] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [editable, setEditable] = useState(true);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function loadPresence() {
    const r = await fetch("/api/settings/env").then((x) => x.json()).catch(() => null);
    if (r?.present) setPresent(r.present);
    if (typeof r?.editable === "boolean") setEditable(r.editable);
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect -- setState runs after the async fetch, not synchronously
  useEffect(() => { loadPresence(); }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const payload = Object.fromEntries(
        Object.entries(values).filter(([, v]) => v.trim() !== ""),
      );
      const r = await fetch("/api/settings/env", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }).then((x) => x.json());
      if (r.ok) {
        const n = r.written?.length ?? 0;
        setMsg({ ok: true, text: n ? `Saved ${n} key${n > 1 ? "s" : ""} to .env (active now).` : "Nothing to save — all fields were blank." });
        setValues({});
        setPresent(r.present ?? present);
      } else {
        setMsg({ ok: false, text: r.error ?? "Save failed." });
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Save failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {!editable && (
        <p className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/30 dark:text-amber-200">
          Secrets are managed by the host on this deployment.
        </p>
      )}
      <label className="flex items-center gap-2 text-xs text-black/60 dark:text-white/60">
        <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
        Reveal what I type
      </label>

      {FIELDS.map((f) => (
        <div key={f.key} className="space-y-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">{f.label}</span>
            {f.required && <span className="text-xs text-amber-700 dark:text-amber-400">required</span>}
            {present[f.key] && <span className="text-xs text-green-700 dark:text-green-400">✓ saved</span>}
          </div>
          <input
            type={f.secret && !reveal ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            disabled={!editable}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            placeholder={present[f.key] ? "•••••••• (leave blank to keep)" : `paste ${f.label}`}
            className="w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm font-mono disabled:opacity-50"
          />
          <p className="text-xs text-black/45 dark:text-white/45">{f.hint}</p>
        </div>
      ))}

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={save}
          disabled={busy || !editable}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save to .env"}
        </button>
        {msg && (
          <span className={`text-sm ${msg.ok ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}`}>
            {msg.ok ? "✓ " : "⚠ "}{msg.text}
          </span>
        )}
      </div>
      <p className="text-xs text-black/45 dark:text-white/45">
        Saved keys apply immediately; add ad accounts, pages, and pixels per client under{" "}
        <a className="underline" href="/settings/clients">Clients</a> and Verify there.
      </p>
    </div>
  );
}
