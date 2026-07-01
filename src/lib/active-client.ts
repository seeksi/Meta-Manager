// The client currently selected in the header switcher, carried in a cookie so server
// components (dashboard, and later other pages) can scope their reads to it.
import { cookies } from "next/headers";
import { BOOTSTRAP_CLIENT_ID, UUID_RE } from "@/lib/clients";

// Keep in sync with the literal in components/client-switcher.tsx (client component can't
// import this server-only module). ponytail: hoist to a shared constants file if a third user appears.
export const ACTIVE_CLIENT_COOKIE = "mam_active_client";

/** Active client id from the switcher cookie, validated as a uuid; falls back to the
 *  bootstrap client for back-compat with the single existing account. Ownership is enforced
 *  at the data layer for multi-operator (single operator owns all clients today). */
export async function activeClientId(): Promise<string> {
  const raw = (await cookies()).get(ACTIVE_CLIENT_COOKIE)?.value;
  return raw && UUID_RE.test(raw) ? raw : BOOTSTRAP_CLIENT_ID;
}
