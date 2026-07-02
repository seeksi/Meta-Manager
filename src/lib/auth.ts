export const SESSION_COOKIE_NAME = "mam_session";

const encoder = new TextEncoder();

function envCredential() {
  const username = process.env.OPERATOR_USERNAME?.trim();
  const password = process.env.OPERATOR_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  if (!username || !password || !secret) return null;
  return { username, password, secret };
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // Fail secure: set Secure on every production deployment EXCEPT the desktop build, which serves
    // NODE_ENV=production over http://127.0.0.1 where a Secure cookie is silently dropped by the
    // client (login returns ok:true but the session never sticks, bouncing back to /login). The
    // electron shell stamps DESKTOP=1 on the Next server env (electron/main.js) to opt out; hosted
    // HTTPS deploys (HOSTED=1 or any other prod host) keep Secure on. Do NOT gate on HOSTED alone —
    // that would ship an insecure cookie on any HTTPS host that hasn't set HOSTED=1.
    secure: (process.env.HOSTED === "1" || process.env.NODE_ENV === "production")
      && process.env.DESKTOP !== "1",
    path: "/",
  };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function hmac(secret: string, payload: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is not available");
  const key = await subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await subtle.sign("HMAC", key, encoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(sig));
}

export async function signSession(operatorId: string, ttlSeconds = 7 * 24 * 3600): Promise<string> {
  const env = envCredential();
  if (!env) throw new Error("operator auth env is not configured");
  const expiryEpoch = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${operatorId}.${expiryEpoch}`;
  const sig = await hmac(env.secret, payload);
  return `v1.${payload}.${sig}`;
}

export async function verifySession(token: string | undefined): Promise<string | null> {
  const env = envCredential();
  if (!env || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, operatorId, expiryRaw, sig] = parts;
  if (!operatorId || !/^\d+$/.test(expiryRaw)) return null;
  if (Number(expiryRaw) < Math.floor(Date.now() / 1000)) return null;
  const expected = await hmac(env.secret, `${operatorId}.${expiryRaw}`);
  return constantTimeEqual(sig, expected) ? operatorId : null;
}

export async function checkCredentials(username: string, password: string): Promise<boolean> {
  const env = envCredential();
  if (!env) return false;
  return constantTimeEqual(username, env.username) && constantTimeEqual(password, env.password);
}

export function readSessionCookie(req: Request): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) return rest.join("=");
  }
  return undefined;
}

export async function operatorIdFromRequest(req: Request): Promise<string | null> {
  return verifySession(readSessionCookie(req));
}
