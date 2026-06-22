# Going Live — Safe Test Runbook

A single ordered checklist to take the app from zero to managing **real** ad spend, safely. It
writes to a live ad account, so the ordering matters: **external spend cap and in-app caps go on
BEFORE writes are ever enabled.** Work top to bottom; don't skip the safety phases.

Prereqs covered here are the "4 blocks": **① database · ② credentials · ③ write-mode/caps ·
④ native spend cap.** Detailed Meta steps live in [`META_SETUP.md`](META_SETUP.md).

---

## Phase 0 — Safety preconditions (do these first)

- [ ] **④ Native Meta account spend cap.** In Ads Manager → **Billing → Payment settings →
      Account spend cap**, set the *maximum acceptable loss* for this account. This is the only
      backstop that holds while the app (and its scheduler) is closed. Set it before anything else.
- [ ] **Use a low-budget / dedicated test ad account** for the first run if you can.
- [ ] Confirm the app ships safe: kill switch engaged + `WRITE_MODE=off` are the defaults — nothing
      writes until you deliberately change both (Phase 5).

## Phase 1 — ① Database

Local (no Neon needed):

```bash
docker compose up -d
export DATABASE_URL=postgres://meta:meta@localhost:5432/meta_ads
npm run db:migrate          # creates all tables
```

Neon: put the standard connection string (`?sslmode=require`) in `DATABASE_URL`, then `npm run db:migrate`.

- [ ] `npm run db:migrate` reports success (14 tables).

## Phase 2 — ② Meta credentials

Follow [`META_SETUP.md`](META_SETUP.md) and fill `.env`:

- [ ] `META_SYSTEM_USER_TOKEN` (never-expiring; scopes `ads_management`, `ads_read`, `business_management`)
- [ ] `META_AD_ACCOUNT_ID`
- [ ] `META_PAGE_ID` (only needed for the launch test, Phase 7)
- [ ] `META_PIXEL_ID` (only needed for CAPI, Phase 8)
- [ ] `META_API_VERSION=v23.0`

Start the app: `npm run desktop` (or `npm run dev`).

## Phase 3 — Verify (read-only, no spend risk)

- [ ] Open **Settings → Connection** and click **Verify**. Expect: `Connected: <account name> (<currency>), account_status …`.
      An error here means a token scope / asset-assignment problem — see the
      [troubleshooting table](META_SETUP.md#troubleshooting). Fix before continuing.

## Phase 4 — First live read (still no writes)

- [ ] **Automation → Scheduler → "Poll now"** (or wait for the 15-min poll). It calls
      `/act_<id>/insights` and ingests into Postgres.
- [ ] Check the **Dashboard** shows metrics, and **Last insights poll** updated on the Scheduler panel.

> At this point reads are proven. Everything so far is non-destructive.

## Phase 5 — ③ Enable writes (carefully)

Writes require **two** gates plus caps — all must allow:

1. [ ] **Env gate:** set `WRITE_MODE=tier_a` (auto only spend-reducing/within-cap actions) or `all`
       (also allow approved Tier B) in `.env`, and restart.
2. [ ] **Automation → Control:** set caps to small test values, then release the kill switch:
       - Max account daily spend ($) — at or below your native cap
       - Max per-action budget delta ($) and (%) — small
       - Target CPA / ROAS, Min metric freshness (min)
       - Set **Write mode** to `tier_a` (or `all`), then **Release** the kill switch.

> Order: caps first, kill switch last. Leaving any cap at `0` blocks the matching action (safe).

## Phase 6 — First guarded write (Tier A)

Pick a **real** campaign with a small budget.

- [ ] **Campaigns → budget editor:** enter the real campaign ID and a small new daily budget →
      submit. A within-caps change is Tier A and auto-executes; an over-caps change routes to the
      **Automation → Approval queue**.
- [ ] Confirm the change landed in **Ads Manager**, and the **Audit log** shows
      `action.proposed` → `action.succeeded`. (Or test a `pause` — always allowed, always safe.)
- [ ] If anything looks wrong, hit the **kill switch** in the header — it halts all writes instantly.

## Phase 7 — First launch (Tier B, created PAUSED)

Needs `META_PAGE_ID` and an **existing ad set** (create the campaign/ad set in Ads Manager first).

- [ ] **Creatives:** upload an image.
- [ ] **Ads → assemble:** pick the creative, add copy/CTA/destination URL + the existing **ad set ID**,
      "Queue launch (Tier B)".
- [ ] **Automation → Approval queue:** approve it. The executor creates the AdCreative + Ad
      **PAUSED** (nothing spends). Verify the paused ad in Ads Manager.
- [ ] When ready to spend, unpause it (also Tier B → approve).

## Phase 8 — Optional integrations

- [ ] **CAPI:** with `META_PIXEL_ID` set, capturing a lead (Leads page / `/api/leads`) forwards a
      hashed `Lead` event; check **Events Manager** for receipt.
- [ ] **Research:** **Research → "Search the Meta Ad Library"** (coverage varies by region).

---

## Abort / rollback

- **Kill switch** (header, every page) → halts all writes immediately.
- `WRITE_MODE=off` in `.env` + restart → disables writes regardless of DB state.
- Native account spend cap → final ceiling even if the app is closed.
- Any write left mid-flight by a crash is demoted to `uncertain` on restart and blocks new
  spend-increasing writes until you resolve it in **Automation → Unresolved writes**.

## Quick reference

| Block | Where | Status |
|---|---|---|
| ① Database | `docker compose up -d` + `npm run db:migrate` | tooling done |
| ② Credentials | `.env` per `META_SETUP.md` | your action |
| ③ Write-mode / caps | `WRITE_MODE` env + **Automation → Control** | in-app, ready |
| ④ Native spend cap | Meta Ads Manager → Billing | your action |
