# Meta Marketing API — Setup Guide

How to create a Meta app and obtain every credential this tool needs. This is **single-brand**:
you manage **your own** ad account, so you do **not** need a lengthy App Review — a System User
with direct asset access gives you everything (see [§7](#7-permissions--access-levels)).

Each step maps 1:1 to the checklist on the app's **Settings → Connection** page (`/settings/connection`).
Fill the matching `.env` variable and the item turns green.

| `.env` variable | This guide |
|---|---|
| `META_APP_ID`, `META_APP_SECRET` | [§2](#2-create-a-meta-app) |
| `META_SYSTEM_USER_TOKEN` | [§4](#4-create-a-system-user--token-the-important-one) |
| `META_AD_ACCOUNT_ID` | [§5](#5-get-your-ad-account-id) |
| `META_PAGE_ID` *(required to launch ads)* | [§5](#5-get-your-ad-account-id) |
| `META_PIXEL_ID` *(optional)* | [§6](#6-pixel--capi-optional-conversion-tracking) |
| `META_API_VERSION` | defaults to `v23.0`; bump only when you migrate |

> ⏱️ ~20–30 minutes. Have admin access to the Meta Business Portfolio that owns your ad account.

---

## 1. Prerequisites

Before touching the developer site, make sure you have:

1. A **Facebook account** that is an **admin** of…
2. …a **Meta Business Portfolio** (formerly Business Manager) — create/check at
   <https://business.facebook.com/settings>.
3. An **ad account** inside that portfolio **with an active payment method**
   (Business Settings → Accounts → Ad accounts). You can't spend without one.
4. *(For conversion tracking only)* a **Pixel / dataset** in Events Manager.

If you run ads today from Ads Manager, you already have 1–3.

---

## 2. Create a Meta app

1. Go to <https://developers.facebook.com/apps> → **Create app**.
   (First time: register as a developer and verify your account.)
2. **Use case:** choose **Other** → **Next**.
3. **App type:** choose **Business** → **Next**. (Business type unlocks the Marketing API and
   ties the app to your Business Portfolio.)
4. Enter an **app name** + contact email, and **select your Business Portfolio**. Create.
5. In the app dashboard, **Add product → Marketing API → Set up**.

**Collect your credentials** (→ `.env`):

- **App ID** — shown at the top of the app dashboard. → `META_APP_ID`
- **App Secret** — **App settings → Basic → App Secret → Show**. → `META_APP_SECRET`

> Keep the App Secret secret. Never ship it to the browser or commit it. This tool only reads it
> server-side from `.env`.

---

## 3. Why a System User (not your personal token)

The token picker in the app dashboard ("Graph API Explorer") issues **short-lived user tokens**
that expire in ~1–2 hours — useless for an always-on tool. Instead create a **System User** token:
server-to-server, tied to the business (not a person), and can be set to **never expire**. This is
the supported path for automated ad management.

---

## 4. Create a System User + token (the important one)

All of this happens in **Business Settings**, not the app dashboard:
<https://business.facebook.com/settings>.

1. **Business Settings → Users → System Users → Add.**
   - Name it (e.g. `ads-manager-bot`).
   - Role: **Admin** (needed to manage campaigns/budgets). Create.
2. **Assign the app:** with the system user selected → **Add Assets → Apps →** select your app →
   enable **Manage app** (full control) → Save.
3. **Assign the ad account:** **Add Assets → Ad accounts →** select your ad account → enable
   **Manage campaigns** (full control) → Save.
   *(Optional, for §6: also add the **Pixel/Dataset** asset.)*
4. **Generate the token:** system user → **Generate new token** → select **your app** →
   - **Token expiration: Never.**
   - **Permissions (scopes):** check
     - `ads_management` — create/update campaigns, budgets, status (writes)
     - `ads_read` — insights/metrics (reads)
     - `business_management` — read business + asset metadata
     - *(optional)* `read_insights`
   - **Generate token** → **copy it now** (shown only once). → `META_SYSTEM_USER_TOKEN`

**Verify the token** before pasting it anywhere:

- Access Token Debugger: <https://developers.facebook.com/tools/debug/accesstoken> — paste the
  token; confirm **Scopes** include the three above and **Expires = Never**.
- Or a quick call (replace the token):
  ```bash
  curl "https://graph.facebook.com/v23.0/me/adaccounts?access_token=YOUR_TOKEN"
  ```
  A JSON list of ad accounts = success. An `error` block = re-check scopes/asset access.

---

## 5. Get your Ad Account ID

**Business Settings → Accounts → Ad accounts** — the **Account ID** is the number shown
(also visible in any Ads Manager URL as `act=XXXXXXXXXX`).

→ `META_AD_ACCOUNT_ID`. You may paste it **with or without** the `act_` prefix — the client
normalizes it (`123456789` and `act_123456789` both work).

### Page ID (required to launch ads)

Launched ads post as a **Facebook Page**, so creating ads needs a Page ID. Find it in
**Business Settings → Accounts → Pages** (or the Page's **About** section). Also **assign the Page
asset to your System User** (§4 step 3, same as the ad account) so the token can use it.
→ `META_PAGE_ID`. *(Not needed for metrics/budget management — only for the ad-launch flow.)*

---

## 6. Pixel + CAPI (optional: conversion tracking)

Needed for lead/purchase attribution and conversion optimization; skip if you only want
metrics + budget/creative management.

1. **Events Manager** → <https://business.facebook.com/events_manager> → your **Pixel/Dataset**.
2. Copy the **Pixel/Dataset ID**. → `META_PIXEL_ID`
3. Conversions API (CAPI) server events reuse `META_SYSTEM_USER_TOKEN` (ensure the Pixel asset is
   assigned to the system user, §4 step 3). Hash PII and send an `event_id` matching the browser
   pixel event for dedup.

---

## 7. Permissions & access levels

**For your own ad account you do _not_ need full App Review.** New apps run in **Development mode**
with **Standard Access** to the Marketing API, which is enough to manage ad accounts the system
user has been granted (§4). That covers this single-brand tool.

You only need **Advanced Access / App Review** if you:

- manage ad accounts you **don't own** (agency / multi-tenant), or
- hit **Standard Access rate limits** and need the higher tier.

To request it later: app dashboard → **App Review → Permissions and Features** → request Advanced
Access for `ads_management` and `ads_read`.

> 🔒 Keep the app in Development mode until you've tested with the **kill switch engaged** and a
> **native account spend cap** set (see [README → Autonomy & safety](../README.md#autonomy--safety-read-before-enabling-writes)).
> This app ships with `WRITE_MODE=off` by default — nothing writes to Meta until you flip it on.

---

## 8. Put it together & verify

1. Add the values to `.env` (see `.env.example`):
   ```bash
   META_API_VERSION=v23.0
   META_APP_ID=...
   META_APP_SECRET=...
   META_SYSTEM_USER_TOKEN=...        # never-expiring system user token
   META_AD_ACCOUNT_ID=...            # with or without act_
   META_PIXEL_ID=...                 # optional
   ```
2. Restart the app (`npm run desktop` / `npm run dev`).
3. Open **Settings → Connection** (`/settings/connection`). Each required item should be green;
   click **Verify**.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `(#200) Permissions error` / `requires ads_management` | Scope missing on the token, or the ad account/app isn't assigned to the system user (§4 steps 2–3). Regenerate the token after fixing assets. |
| `Invalid OAuth access token` / works then stops | Token expired — you generated a user token, not a **never-expiring System User** token (§3–4). |
| `Unsupported get request` / `does not exist` on the ad account | Wrong `META_AD_ACCOUNT_ID`, or the system user lacks access to it. Confirm in Business Settings → Ad accounts. |
| `(#17) User request limit reached` | Standard Access rate limit. Back off (the client already retries with backoff); request Advanced Access for higher limits (§7). |
| Token debugger shows `Expires: in ~1 hour` | Not a system user token. Redo §4 with **Expiration: Never**. |

**Reference docs**

- Marketing API: <https://developers.facebook.com/docs/marketing-api>
- System Users: <https://developers.facebook.com/docs/marketing-api/system-users>
- Access Token Debugger: <https://developers.facebook.com/tools/debug/accesstoken>
- API changelog / versions: <https://developers.facebook.com/docs/graph-api/changelog>
