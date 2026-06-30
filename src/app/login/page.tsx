"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { Card } from "@/components/ui";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "Login failed");
        return;
      }
      const next = new URLSearchParams(window.location.search).get("next") || "/";
      window.location.assign(next.startsWith("/") ? next : "/");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm">
      <Card>
        <h1 className="mb-1 text-lg font-semibold">Operator login</h1>
        <p className="mb-4 text-sm text-black/60 dark:text-white/60">Sign in to manage the Meta Ads console.</p>
        <form onSubmit={submit} className="space-y-3">
          <label className="block space-y-1 text-sm">
            <span>Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="w-full rounded-md border border-black/15 bg-transparent px-3 py-1.5 dark:border-white/15"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>Password</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete="current-password"
              className="w-full rounded-md border border-black/15 bg-transparent px-3 py-1.5 dark:border-white/15"
            />
          </label>
          <button
            disabled={busy}
            className="w-full rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? "Signing in..." : "Sign in"}
          </button>
          {error && <p className="text-sm text-amber-700 dark:text-amber-400">{error}</p>}
        </form>
      </Card>
    </div>
  );
}
