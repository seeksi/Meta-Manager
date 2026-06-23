// Read/merge credential values into the project .env from the running server.
// Single-operator desktop app: the operator owns this machine, so persisting their
// own API keys to a local .env is the intended flow. Values are also written into
// process.env so the running server (verify, scheduler) picks them up without a restart.
//
// Safety at this trust boundary: callers must pass an allowlisted key set; values must
// be single-line (prevents .env injection); secrets are never read back to the client
// (only presence is exposed). The file is written 0600.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

// ponytail: writes to <cwd>/.env — correct for dev / from-source runs (cwd = project root).
// Upgrade path: for the packaged Electron AppImage (read-only app dir), resolve a writable
// userData path and load it at boot instead.
function envPath() {
  return path.join(process.cwd(), ".env");
}

export type EnvUpdates = Record<string, string | undefined>;

// Merge updates into .env, preserving existing lines, comments, and order. Only non-empty
// trimmed values are written — a blank field leaves the existing value untouched.
export function writeEnvKeys(updates: EnvUpdates): string[] {
  const file = envPath();
  const original = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = original.length ? original.split(/\r?\n/) : [];
  const written: string[] = [];

  for (const [key, raw] of Object.entries(updates)) {
    const value = (raw ?? "").trim();
    if (!value) continue;
    if (/[\r\n]/.test(value)) throw new Error(`Invalid value for ${key}: must be a single line`);
    // Quote only when the raw value would break dotenv parsing (whitespace, #, quotes).
    const formatted = /[\s#"']/.test(value) ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
    const line = `${key}=${formatted}`;
    const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
    process.env[key] = value; // live update — running server uses it immediately
    written.push(key);
  }

  const out = lines.join("\n").replace(/\n*$/, "\n");
  writeFileSync(file, out, { mode: 0o600 });
  return written;
}

export function envPresence(keys: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(keys.map((k) => [k, !!process.env[k]?.trim()]));
}
