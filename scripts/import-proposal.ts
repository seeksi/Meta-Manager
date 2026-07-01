#!/usr/bin/env -S npx tsx
/**
 * M4 (WS-4) importer: an APPROVED `proposal.md` → scoped `ad_actions` proposal rows.
 *
 * Parses the single ```actions JSON block from a proposal.md and POSTs each mappable fix to the
 * engine's EXISTING `POST /api/actions` (→ proposeAction → guardrails → ad_actions row), scoped
 * to one client. No new engine code, no second code path. In `observe` write mode the engine
 * creates rows WITHOUT writing to Meta — this script never touches the Meta API itself.
 *
 * Usage:
 *   npx tsx scripts/import-proposal.ts --file <proposal.md> --client <uuid|name> \
 *     [--base http://localhost:3000] [--dry-run]
 *
 * Auth: if OPERATOR_USERNAME/OPERATOR_PASSWORD are set, logs in first and sends the session
 * cookie (so it keeps working once every /api/** route is gated). If unset, posts directly.
 *
 * ponytail: single ```actions block + CLI is enough for solo-agency volume; upgrade to a UI
 * "import proposal" button + multi-block proposals when close volume justifies it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ACTION_TYPES } from "../src/lib/guardrails";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirror of the caller-supplied fields of ProposeInputSchema (src/lib/automation.ts) PLUS the
// audit-trace field. Validated here so a malformed proposal fails before hitting the network.
export const ItemSchema = z
  .object({
    actionType: z.enum(ACTION_TYPES),
    entityType: z.enum(["account", "campaign", "adset", "ad"]),
    entityId: z.string().min(1).max(256),
    targetState: z.record(z.string(), z.unknown()), // absolute target, never a delta
    dailyBudgetDeltaCents: z.number().int().optional(),
    dailyBudgetDeltaPct: z.number().optional(),
    projectedDailySpendCents: z.number().int().min(0).optional(),
    auditFinding: z.string().min(1).max(500), // every row must trace to an audit finding — no fabricated ROI
  })
  .strict();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

export function extractActionsBlock(md: string): string {
  const m = md.match(/```actions\s*\n([\s\S]*?)```/);
  if (!m) throw new Error("no ```actions block found in proposal (mappable fixes go in a single ```actions JSON array)");
  return m[1];
}

export type Item = z.infer<typeof ItemSchema>;

/** Parse + validate every item in a proposal's ```actions block (a JSON array). */
export function parseProposalActions(md: string): Item[] {
  let raw: unknown;
  try {
    raw = JSON.parse(extractActionsBlock(md));
  } catch (e) {
    throw new Error(`\`\`\`actions block is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new Error("```actions block must be a JSON array");
  return raw.map((r, i) => {
    const p = ItemSchema.safeParse(r);
    if (!p.success) throw new Error(`item ${i + 1} invalid: ${JSON.stringify(p.error.issues)}`);
    return p.data;
  });
}

/** Map one validated item → the POST /api/actions body for a given client. The ONLY place
 *  client scoping + origin tagging + the deterministic idempotency key are decided. */
export function buildActionBody(item: Item, clientId: string, proposalId: string, proposalPath: string) {
  const { auditFinding, ...action } = item;
  // Deterministic key so re-importing an approved proposal never duplicates rows
  // (the engine de-dupes via ad_actions.idempotencyKey unique + onConflictDoNothing).
  const idempotencyKey = "proposal:" + createHash("sha256")
    .update(`${clientId}:${item.actionType}:${item.entityId}:${auditFinding}`)
    .digest("hex");
  return {
    ...action,
    clientId,
    actor: "proposal-closer" as const,
    evidence: { auditFinding, proposalId, proposalPath },
    idempotencyKey,
  };
}

async function main() {
  const file = arg("file");
  const clientArg = arg("client");
  const base = (arg("base") ?? process.env.ENGINE_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const dryRun = hasFlag("dry-run");
  if (!file || !clientArg) {
    console.error("usage: tsx scripts/import-proposal.ts --file <proposal.md> --client <uuid|name> [--base URL] [--dry-run]");
    process.exit(2);
  }

  const md = readFileSync(file, "utf8");
  const items = parseProposalActions(md);

  // --dry-run is a fully offline lint: validate the block + show what WOULD be sent, no network.
  if (dryRun) {
    console.log(`[dry-run] ${items.length} valid action(s) for client "${clientArg}" (no network):\n`);
    console.log("ACTION           ENTITY               AUDIT FINDING");
    for (const it of items) console.log(`${it.actionType.padEnd(16)} ${it.entityId.padEnd(20)} ${it.auditFinding}`);
    return;
  }

  // --- optional auth: log in if operator creds are present (G4-ready) ---
  let cookie = "";
  const username = process.env.OPERATOR_USERNAME;
  const password = process.env.OPERATOR_PASSWORD;
  if (username && password) {
    const r = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) throw new Error(`login failed (${r.status})`);
    cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
    if (!cookie) throw new Error("login returned no session cookie");
  }
  const authHeaders: Record<string, string> = cookie ? { cookie } : {};

  // --- resolve client: uuid passes through; a name is matched via GET /api/clients ---
  let clientId: string;
  if (UUID_RE.test(clientArg)) {
    clientId = clientArg;
  } else {
    const r = await fetch(`${base}/api/clients`, { headers: authHeaders });
    if (!r.ok) {
      throw new Error(`cannot list clients to resolve "${clientArg}" (${r.status})${r.status === 401 ? " — set OPERATOR_USERNAME/OPERATOR_PASSWORD or pass the client uuid" : ""}`);
    }
    const body = (await r.json()) as { clients: { id: string; name: string }[] };
    const matches = body.clients.filter((c) => c.name.toLowerCase() === clientArg.toLowerCase());
    if (matches.length === 0) throw new Error(`no client named "${clientArg}"`);
    if (matches.length > 1) throw new Error(`client name "${clientArg}" is ambiguous (${matches.length} matches) — pass the uuid`);
    clientId = matches[0].id;
  }

  // proposalId ties every emitted row back to THIS proposal revision (audit trace).
  const proposalId = createHash("sha256").update(md).digest("hex").slice(0, 16);

  console.log(`${dryRun ? "[dry-run] " : ""}importing ${items.length} action(s) for client ${clientId} → ${base}\n`);

  const out: string[] = [];
  for (const item of items) {
    const r = await fetch(`${base}/api/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify(buildActionBody(item, clientId, proposalId, file)),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      out.push(`FAIL(${r.status})       ${item.actionType.padEnd(16)} ${item.entityId.padEnd(20)} ${JSON.stringify(json)}`);
      continue;
    }
    const a = (json as { action?: { id?: string; status?: string } }).action ?? {};
    out.push(`${(a.status ?? "?").padEnd(16)} ${item.actionType.padEnd(16)} ${item.entityId.padEnd(20)} ${a.id ?? ""}`);
  }
  console.log("STATUS           ACTION           ENTITY               ROW / DETAIL");
  console.log(out.join("\n"));
}

// Run only when invoked as a CLI — importing this module (tests) must be side-effect-free.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("import failed:", e?.message ?? e);
    process.exit(1);
  });
}
