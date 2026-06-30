# M0 — Meta Advanced Access & Client Onboarding · operator walkthrough

> **Audience:** a non-engineer assistant (or the operator) clicking through Meta's web UIs.
> **Goal:** get the agency from "manages only our own ad account (Standard Access)" to
> "can legally manage a paying client's ad account we don't own (Advanced Access + asset grant)."
> **This is the M0 long pole** in `docs/AGENCY_BUILD_SPEC.md` §6/§7 — start it in parallel; it has
> a multi-day–to–multi-week lead time because of Meta's review queue and the client's own action.
>
> **You do NOT need this to finish or demo M2.** M2's acceptance gate runs against the operator's
> *own* account under **Standard Access** — see `docs/META_SETUP.md` (that's "Tier 1"). This doc is
> "Tier 2": what unlocks managing *other people's* accounts. Do Tier 1 first; it takes 20–30 min.
>
> ⚠️ **Security rules — non-negotiable:**
> - Never paste the **System User token** or **App Secret** into chat, a ticket, email, or a
>   screenshot. The token is shown **once**. Put it straight into the server `.env` (see §4).
> - Keep the app in **Development mode** with `WRITE_MODE=off` / kill switch engaged until a real
>   client is verified in `observe` mode.

---

## Prerequisites (confirm these exist before starting)

1. A **Facebook account** that is an **admin** of the agency's **Meta Business Portfolio**
   (formerly Business Manager): <https://business.facebook.com/settings>.
2. A **Meta Developer App** of type **Business**, tied to that portfolio
   (App ID/Secret → `META_APP_ID`/`META_APP_SECRET`). If it doesn't exist yet, create it via
   `docs/META_SETUP.md` §2 first, then come back here.
3. A **never-expiring System User token** with scopes `ads_management`, `ads_read`,
   `business_management`, `read_insights` (→ `META_SYSTEM_USER_TOKEN`). Create via
   `docs/META_SETUP.md` §4 if missing. This same token is what manages *every* client under
   Model A (single agency token); clients never supply their own.
4. A **published privacy policy URL** on a domain you control (App Review requires it).
5. A **business email + website** for the agency (Ads by Rex / adsbyrex.com).

> If 1–3 are already done for the own-account (Tier 1) setup, you only need steps **A → D** below.

---

## A. Business Verification (do this first — it gates App Review)

Meta won't grant Advanced Access for ads scopes to an unverified business.

1. Go to **Business Settings → Security Center**:
   <https://business.facebook.com/settings/security-center>.
2. Find **Business verification** → **Start verification**.
3. Provide the **legal business name, address, phone**, and a **verification method** (Meta will
   call/text/email, or ask for a document — e.g. a utility bill, business license, or
   articles of incorporation showing the name+address).
4. Submit. **Status to hand back:** `Pending` / `Verified` / `Needs more info`.

> Sole proprietor / no formal entity? Meta accepts individual-level verification in many regions,
> but the smoother path is a registered business name + matching domain email. Flag to the operator
> if no legal entity exists — this is a real-world decision, not a clicking step.

**Lead time:** minutes to a few business days.

---

## B. App Review — request Advanced Access for the ads scopes

You're upgrading the app from **Standard Access** (own assets only) to **Advanced Access**
(manage assets you don't own) on two permissions.

1. Open the app dashboard: <https://developers.facebook.com/apps> → select the agency app.
2. Left nav → **App Review → Permissions and Features**.
3. Find **`ads_management`** → click **Request Advanced Access**. Repeat for **`ads_read`**.
   (Optionally `business_management` if shown as Standard-only.)
4. Each permission opens a **request form** that needs:
   - **How your app uses the permission** — a 2–4 sentence use-case. Template:
     > "Ads by Rex is an agency tool that manages Meta ad campaigns on behalf of clients who
     > grant us access to their ad accounts via Business Manager asset sharing. We use
     > `ads_management` to create/adjust campaigns, budgets and statuses, and `ads_read` to pull
     > performance insights, strictly for ad accounts our clients have explicitly assigned to our
     > Business Portfolio. No data is resold; access is per-client and revocable."
   - **A screencast** (see §C) demonstrating the actual flow.
   - **Privacy policy URL** (prerequisite #4).
5. Submit each permission. **Status to hand back:** `In review` / `Approved` / `Rejected (reason)`.

**Lead time:** typically a few days; can be longer. Rejections usually cite a weak screencast or
use-case — re-record §C more explicitly and resubmit.

---

## C. The screencast (the step most likely to bounce a submission)

Meta wants a screen recording proving the permission is used as described. Record (Loom/QuickTime):

1. Log into the **Ads by Rex** tool.
2. Show the **Add Client** onboarding page → enter a (test) client's ad account / page / pixel.
3. Click **Verify access** → show the green success (this is the live `verifyAccess` round-trip).
4. Show the dashboard pulling that account's **insights** (proves `ads_read`).
5. Narrate that campaign changes go through an approval/observe gate (proves controlled
   `ads_management` use, not unsupervised access).

Upload the video and attach/link it in each permission request from §B.

> The tool's own UI is the demo. Run it in `observe` mode against the operator's own account so
> there's a real, safe account to show.

---

## D. Per-client asset grant (the client must do their part — you cannot)

This is **not automatable** and **not yours to click** — the *client* acts in *their* Business
Manager. Two supported directions; pick whichever the client finds easier:

**Option 1 — Client assigns assets to your Business (cleanest):**
The client goes to their **Business Settings → Accounts**, and for each of **Ad Account**, **Page**,
and **Pixel/Dataset**: **Assign partner → by Business ID** → enters **the agency's Business ID**
(find yours in Business Settings → Business Info) → grants **Manage** on the ad account
(and Pixel) and the needed Page role.

**Option 2 — You request access from the client:**
In **your** Business Settings → **Partners / Requests**, request the client's assets by their
Business ID; the client approves the request in their portal.

After the grant lands, in **your** Business Settings → **System Users** → your `ads-manager-bot`
user → **Add Assets**, confirm the newly-shared **Ad Account + Page + Pixel** are assigned to the
system user with **Manage** — otherwise the agency token can see the asset but can't act on it.

**What to collect from the client (hand these to the engineer / paste into the onboarding form):**
- Ad Account ID (`act_…` or the bare number)
- Page ID
- Pixel / Dataset ID (if they want conversion tracking)

**Lead time:** depends entirely on the client. This is usually the real bottleneck, not Meta.

---

## E. Verify it actually works (before any spend)

1. With assets granted, debug the agency token:
   <https://developers.facebook.com/tools/debug/accesstoken> — confirm scopes + **Expires: Never**.
2. Quick read against the *client's* account (replace both values):
   ```bash
   curl "https://graph.facebook.com/v23.0/act_<CLIENT_AD_ACCOUNT_ID>/campaigns?fields=name,status&access_token=<AGENCY_TOKEN>"
   ```
   A JSON list of campaigns = the grant + scopes are correct. An `error` block → re-check §D
   (asset assigned to the **system user**, with **Manage**) and §B (scope approved).
3. In the tool: **Add Client** → enter the client's IDs → **Verify access** → expect green.
   The client lands in **`observe`** with the kill switch engaged — **leave it there** until the
   operator deliberately graduates it.

---

## Status summary to report back

When done (or blocked), report these six lines so the engineer knows exactly where things stand:

- Business verification: `Pending | Verified | Needs-info (what)`
- `ads_management` Advanced Access: `Standard | In review | Approved | Rejected (why)`
- `ads_read` Advanced Access: `Standard | In review | Approved | Rejected (why)`
- Screencast: `not yet | submitted | reapproved`
- First client asset grant: `not requested | requested | granted (account/page/pixel IDs)`
- Live verify (`curl` / Add-Client): `pass | fail (Meta error verbatim)`

---

## What I (the engineer/agent) can drive vs. what needs a human

| Step | Automatable? |
|---|---|
| A. Business verification | ❌ legal identity / Meta back-office |
| B. App Review form click-through | ⚠️ partially (navigation only); the use-case text & submit are a judgment call |
| C. Screencast | ❌ must be recorded live |
| D. Client asset grant | ❌ third party acts in their own account |
| D. Confirm assets on system user (our side) | ⚠️ can pair on it live via browser |
| E. `curl` verify + Add-Client verify | ✅ I run these once the token + grant exist |

Anything marked ✅/⚠️ I'll do live on request; the ❌ rows are why this is a walkthrough, not a bot.
