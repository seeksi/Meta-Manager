// Module 1 — Meta connection status. docs/PRODUCT_SPEC.md §1. Single-brand: credentials
// live in env. This reports which are present and a (provisional) verify state. Real live
// verification is owned by meta-api-integrator once the Meta app is approved.

const present = (k: string) => !!process.env[k]?.trim();

export interface ConnectionStatus {
  apiVersion: string;
  steps: { key: string; label: string; done: boolean; required: boolean }[];
}

export function connectionStatus(): ConnectionStatus {
  return {
    apiVersion: process.env.META_API_VERSION ?? "v23.0",
    steps: [
      { key: "appCreds", label: "Meta app created (App ID + Secret)", required: true,
        done: present("META_APP_ID") && present("META_APP_SECRET") },
      { key: "token", label: "System-user token (ads_management, ads_read, business_management)", required: true,
        done: present("META_SYSTEM_USER_TOKEN") },
      { key: "adAccount", label: "Ad account selected", required: true, done: present("META_AD_ACCOUNT_ID") },
      { key: "pixel", label: "Pixel + CAPI configured", required: false, done: present("META_PIXEL_ID") },
      { key: "database", label: "Database connected", required: true, done: present("DATABASE_URL") },
      { key: "aiGateway", label: "AI Gateway key (copywriting)", required: false, done: present("AI_GATEWAY_API_KEY") },
      { key: "blob", label: "Blob storage (creative uploads)", required: false, done: present("BLOB_READ_WRITE_TOKEN") },
    ],
  };
}

export async function verifyConnection() {
  if (!present("META_SYSTEM_USER_TOKEN")) {
    return { ok: false, message: "System-user token not set. Add META_SYSTEM_USER_TOKEN (see .env.example)." };
  }
  if (!present("META_AD_ACCOUNT_ID")) {
    return { ok: false, message: "Ad account not set. Add META_AD_ACCOUNT_ID." };
  }
  // Live round-trip: read the configured ad account. Surfaces token/scope/asset errors directly.
  try {
    const { verifyAccess } = await import("@/lib/meta/client");
    const a = await verifyAccess();
    return {
      ok: true,
      message: `Connected: ${a.name ?? a.id}${a.currency ? ` (${a.currency})` : ""}, account_status ${a.accountStatus ?? "?"}.`,
      account: a,
    };
  } catch (e) {
    return { ok: false, message: `Meta API rejected the request: ${e instanceof Error ? e.message : String(e)}` };
  }
}
