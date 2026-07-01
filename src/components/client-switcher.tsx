"use client";
// Header client switcher: lists the operator's clients and pins the active one in a cookie,
// then refreshes so server components re-read it. Hidden until at least one client loads
// (single-account setups have nothing to switch). ponytail: server pages other than the
// dashboard still default to the bootstrap client — wire activeClientId() into them as they go multi-client.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// Keep in sync with ACTIVE_CLIENT_COOKIE in lib/active-client.ts.
const COOKIE = "mam_active_client";

type ClientOption = { id: string; name: string; status: string; verifyState: string };

function readCookie(name: string): string | null {
  for (const part of document.cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function ClientSwitcher() {
  const router = useRouter();
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    let alive = true;
    fetch("/api/clients")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!alive || !data?.clients) return;
        const rows: ClientOption[] = data.clients
          .map((c: Record<string, unknown>) => ({
            id: String(c.id),
            name: String(c.name),
            status: String(c.status),
            verifyState: String(c.verifyState),
          }))
          .filter((c: ClientOption) => c.status !== "archived");
        setClients(rows);
        setActive(readCookie(COOKIE) ?? rows[0]?.id ?? "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (clients.length === 0) return null;

  function onChange(id: string) {
    setActive(id);
    document.cookie = `${COOKIE}=${encodeURIComponent(id)}; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`;
    router.refresh();
  }

  return (
    <label className="flex items-center gap-2 text-sm text-black/60 dark:text-white/60">
      <span className="hidden sm:inline">Client</span>
      <select
        value={active}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1 text-sm"
      >
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.verifyState === "active" ? "" : " (unverified)"}
          </option>
        ))}
      </select>
    </label>
  );
}
