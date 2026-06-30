"use client";
import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui";

type ClientRow = {
  id: string;
  name: string;
  status: string;
  verifyState: string;
  metaAccountId: string;
  pageId: string | null;
  pixelId: string | null;
  writeMode: string | null;
};

type Message = { ok: boolean; text: string };

type FormState = {
  name: string;
  metaAccountId: string;
  pageId: string;
  pixelId: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  metaAccountId: "",
  pageId: "",
  pixelId: "",
};

const INPUT_CLASS = "w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-3 py-1.5 text-sm";
const BUTTON_CLASS = "rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function jsonErrorText(value: unknown, fallback: string) {
  if (!isRecord(value)) return fallback;
  if (typeof value.message === "string") return value.message;
  if (typeof value.error === "string") return value.error;
  if (value.error !== undefined) return JSON.stringify(value.error);
  return fallback;
}

function isClientRow(value: unknown): value is ClientRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.status === "string" &&
    typeof value.verifyState === "string" &&
    typeof value.metaAccountId === "string" &&
    (typeof value.pageId === "string" || value.pageId === null) &&
    (typeof value.pixelId === "string" || value.pixelId === null) &&
    (typeof value.writeMode === "string" || value.writeMode === null)
  );
}

function verifyBadgeClass(verifyState: string) {
  if (verifyState === "active") return "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300";
  if (verifyState === "failed") return "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300";
  if (verifyState === "verifying") return "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300";
  return "bg-black/10 text-black/60 dark:bg-white/10 dark:text-white/60";
}

function compactPayload(form: FormState) {
  return Object.fromEntries(
    Object.entries(form)
      .map(([key, value]) => [key, value.trim()])
      .filter(([, value]) => value !== ""),
  );
}

export function ClientsManager() {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [formMsg, setFormMsg] = useState<Message | null>(null);
  const [rowMsg, setRowMsg] = useState<Record<string, Message>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data: unknown = await fetch("/api/clients").then((r) => r.json());
      if (isRecord(data) && Array.isArray(data.clients)) {
        setClients(data.clients.filter(isClientRow));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function addClient() {
    setAdding(true);
    setFormMsg(null);
    try {
      const data: unknown = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(compactPayload(form)),
      }).then((r) => r.json());

      if (isRecord(data) && data.ok === true) {
        setForm(EMPTY_FORM);
        await reload();
        setFormMsg({ ok: true, text: "Client added — click Verify access to connect it." });
      } else {
        setFormMsg({ ok: false, text: jsonErrorText(data, "Add client failed.") });
      }
    } catch (e) {
      setFormMsg({ ok: false, text: e instanceof Error ? e.message : "Add client failed." });
    } finally {
      setAdding(false);
    }
  }

  async function verify(id: string) {
    setBusy((b) => ({ ...b, [id]: true }));
    setRowMsg((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
    try {
      const data: unknown = await fetch(`/api/clients/${id}/verify`, { method: "POST" }).then((r) => r.json());
      if (isRecord(data) && data.ok === true) {
        const account = isRecord(data.account) ? data.account : null;
        const accountLabel =
          typeof account?.name === "string"
            ? account.name
            : typeof account?.id === "string"
              ? account.id
              : "account";
        setRowMsg((m) => ({ ...m, [id]: { ok: true, text: `Connected: ${accountLabel}` } }));
      } else {
        setRowMsg((m) => ({ ...m, [id]: { ok: false, text: jsonErrorText(data, "Verify access failed.") } }));
      }
      await reload();
    } catch (e) {
      setRowMsg((m) => ({ ...m, [id]: { ok: false, text: e instanceof Error ? e.message : "Verify access failed." } }));
      await reload();
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="mb-3 font-medium">Add client</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="client-name">Name</label>
            <input
              id="client-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className={INPUT_CLASS}
              required
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="client-ad-account">Ad Account ID</label>
            <input
              id="client-ad-account"
              value={form.metaAccountId}
              onChange={(e) => setForm((f) => ({ ...f, metaAccountId: e.target.value }))}
              className={INPUT_CLASS}
              required
            />
            <p className="text-xs text-black/45 dark:text-white/45">with or without act_</p>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="client-page">Page ID</label>
            <input
              id="client-page"
              value={form.pageId}
              onChange={(e) => setForm((f) => ({ ...f, pageId: e.target.value }))}
              className={INPUT_CLASS}
            />
            <p className="text-xs text-black/45 dark:text-white/45">to launch ads</p>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="client-pixel">Pixel ID</label>
            <input
              id="client-pixel"
              value={form.pixelId}
              onChange={(e) => setForm((f) => ({ ...f, pixelId: e.target.value }))}
              className={INPUT_CLASS}
            />
            <p className="text-xs text-black/45 dark:text-white/45">for Conversions API</p>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={addClient}
            disabled={adding || form.name.trim() === "" || form.metaAccountId.trim() === ""}
            className={BUTTON_CLASS}
          >
            {adding ? "Adding…" : "Add client"}
          </button>
          {formMsg && (
            <span className={`text-sm ${formMsg.ok ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}`}>
              {formMsg.ok ? "✓ " : "⚠ "}{formMsg.text}
            </span>
          )}
        </div>
      </Card>

      <Card>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-medium">Clients</h2>
          {loading && <span className="text-xs text-black/45 dark:text-white/45">Loading…</span>}
        </div>
        {clients.length === 0 ? (
          <p className="text-sm text-black/60 dark:text-white/60">No clients yet.</p>
        ) : (
          <div className="space-y-3">
            {clients.map((client) => (
              <div
                key={client.id}
                className="rounded-md border border-black/10 dark:border-white/10 p-3"
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <div className="font-medium">{client.name}</div>
                    <div className="text-sm text-black/60 dark:text-white/60">{client.metaAccountId}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${verifyBadgeClass(client.verifyState)}`}>
                      {client.verifyState}
                    </span>
                    <span className="rounded-full bg-black/10 px-2 py-0.5 text-xs text-black/60 dark:bg-white/10 dark:text-white/60">
                      {client.writeMode ?? "—"}
                    </span>
                    <button
                      onClick={() => verify(client.id)}
                      disabled={Boolean(busy[client.id])}
                      className={BUTTON_CLASS}
                    >
                      {busy[client.id] ? "Verifying…" : "Verify access"}
                    </button>
                  </div>
                </div>
                {rowMsg[client.id] && (
                  <div className={`mt-2 text-sm ${rowMsg[client.id].ok ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}`}>
                    {rowMsg[client.id].ok ? "✓ " : "⚠ "}{rowMsg[client.id].text}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
