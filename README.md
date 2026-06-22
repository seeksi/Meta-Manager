# Meta Ads Manager

Single-brand, single-operator Meta Ads management console. Monitor metrics, adjust budgets,
upload creatives, assemble & launch ads, generate copy, research competitors, run tiered
optimization — all from one **desktop app**, with a guardrailed autonomy engine over real ad spend.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md).

## Stack

Electron desktop shell wrapping Next.js (App Router) + TypeScript · Neon Postgres + Drizzle ·
in-process scheduler (durable jobs run while the app is open) · Vercel Blob (creatives) ·
Vercel AI Gateway (copywriting) · Tailwind.

## Setup

```bash
npm install
cp .env.example .env        # fill in the values below

npm run desktop             # dev: launches the Electron window over `next dev`
npm run desktop:prod        # build the standalone server + run it in Electron
# or browser-only:
npm run dev                 # http://localhost:3000
```

### Package an installer

```bash
npm run dist                # → release/Meta Ads Manager-<version>.AppImage  (Linux, ~115 MB)
```

`dist` runs `build:standalone` (Next standalone server + copies `public/` and `.next/static`
into it), then electron-builder bundles it. The self-contained server ships under
`resources/standalone/` (its own `node_modules`); `main.js` boots it with the app's Electron
binary as Node. The AppImage is self-contained — no Node/Next install needed to run it. Config
is the `build` field in `package.json`; the placeholder icon is `build/icon.png` (replace with a
real brand icon). To add a `.deb`, append `"deb"` to `build.linux.target`. Output is gitignored.

> `npm install` downloads the Electron binary via a postinstall script. If your environment
> blocks install scripts, approve it (`npm approve-scripts electron`) or reinstall with scripts
> enabled before `npm run desktop` / `npm run dist`.

The background scheduler (insights poll every 15 min, optimizer daily at 09:00 local) runs
in-process whenever the server is up — so automation is active while the desktop app is open.
Set `DISABLE_SCHEDULER=1` to turn it off. The native Meta account spend cap remains the 24/7
backstop for the hours the app is closed.

### Environment (`.env`)

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` / `DATABASE_URL_UNPOOLED` | Neon pooled (runtime) / direct (migrations) |
| `META_API_VERSION`, `META_SYSTEM_USER_TOKEN`, `META_AD_ACCOUNT_ID`, `META_APP_ID/SECRET`, `META_PIXEL_ID` | Meta Marketing API + CAPI — **see [`docs/META_SETUP.md`](docs/META_SETUP.md)** |
| `AI_GATEWAY_API_KEY`, `COPY_MODEL` | AI copywriting (default `anthropic/claude-sonnet-4-6`) |
| `BLOB_READ_WRITE_TOKEN` | Creative uploads |
| `DISABLE_SCHEDULER` | set `1` to stop the in-process scheduler |
| `WRITE_MODE` | env-level master gate: `off`/`observe`/`tier_a`/`all` |

The app runs without credentials — pages degrade gracefully and API routes return 503. Add
credentials to light up each module.

### Database

```bash
npx drizzle-kit generate   # already generated: drizzle/0000_init, 0001_competitor_creatives
npx drizzle-kit migrate    # apply to your Neon DB
```

## Autonomy & safety (read before enabling writes)

This app writes to a live ad budget. Safeguards, in order:

1. **Kill switch** (`emergency_stop`) — header button on every page; halts all writes instantly.
2. **Env gate** `WRITE_MODE=off` — disables writes regardless of DB state.
3. **Tiered guardrails** — Tier A (pause/decrease within caps) auto-executes; Tier B (new
   campaigns, budget increases, audience expansion) requires in-UI approval. Default-deny on
   stale metrics / policy change / cap math failure.
4. **Executor-only writes** — only `executeAdAction` (`src/lib/automation.ts`) calls Meta; UI/AI/
   optimizer only ever propose. It re-runs preflight guardrails immediately before each write.
   Edits are absolute targets (safe to retry); ambiguous writes are marked `uncertain` and
   reconciled on the next poll. **Ad launch** is a two-phase create saga (AdCreative → Ad,
   created **PAUSED**): each phase's Meta id is persisted durably, and before creating, the
   executor reconciles by a launch token embedded in the object name to adopt anything a crashed
   retry already created (>1 match → fail closed) — so creates don't duplicate.
5. **Crash recovery + unresolved-write gate** — the action ledger (`ad_actions`) is durable in
   Postgres. A write left `executing` by a process crash is demoted to `uncertain` at startup
   (never assumed applied); while any write is `executing`/`uncertain`, new spend-increasing
   proposals are blocked (`UNRESOLVED_WRITES`) until reconciled — pauses/decreases stay allowed.
6. **External backstop** — also set a **native Meta account spend cap**. The app's guardrails are
   necessary but the platform-level cap is the real last line of defense, especially for the
   hours the desktop app (and its scheduler) is closed.

Configure caps and write mode at **/automation**.

## Status

Live Meta paths wired (need real credentials to exercise): insights read, absolute-patch writes
(pause/budget), connection verify (`GET /me` ad account), **ad launch** (AdCreative + paused Ad),
competitor research (`/ads_archive`), and conversions (CAPI `/{pixel}/events`). To run live tests
see [`docs/META_SETUP.md`](docs/META_SETUP.md) — needs a DB (`npx drizzle-kit migrate`), credentials,
`WRITE_MODE` enabled, and a native Meta spend cap. Remaining `ponytail:` ceilings are noted inline.
