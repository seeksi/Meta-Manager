# M0 — "Test + Publish the app" · live pairing session log

> Running log for the paired push to get the Meta app **fully tested + published** (Live +
> Advanced Access for agency client management). **Agent drives + notates; operator does
> human-only steps.** Updated as we go. Companion to `M0-advanced-access-walkthrough.md`.

**Goal restated:** tool runs end-to-end (Add Client → Verify → live insights, zero writes) AND
the Meta app is review-ready, submitted for Advanced Access on `ads_management`/`ads_read`, and
switched to Live so we can onboard accounts we don't own.

---

## ✅ Confirmed DONE (verified live this session)

- **System User token** — valid, type `SYSTEM_USER`, **never expires** (`expires_at: 0`).
- **Scopes present:** `ads_management`, `ads_read`, `business_management`, `read_insights`
  (+ `pages_*`, `leads_retrieval`). No additional ads scopes needed.
- **Bootstrap ad account reads cleanly:** `act_3699053450232949` ("General_Meta_Ads", status
  active, USD) returns via direct `act_<id>` GET — exactly the call the tool's `verifyAccess` makes.
  (`/me/adaccounts` lists 0 — known system-user enumeration quirk, not a problem.)
- **Page available:** "Ads by Rex" = `1057312234142015` → use as `META_PAGE_ID`.
- **App identity:** App ID `2929423800765087`, name "General-Ads-Manager", app secret set.
- **Code:** M1 (`verifyAccess(ctx)` is client-context-scoped) + M2 onboarding endpoints
  (`api/clients/route.ts`, `api/clients/[id]/verify/route.ts`) exist in the working tree.

## ⚠️ BLOCKERS / OPEN ITEMS

| # | Item | Owner | Notes |
|---|---|---|---|
| 1 | **`DATABASE_URL` not set** — tool can't run end-to-end without Postgres | decision | Local Postgres vs. existing Neon URL. Gates the screencast + verify demo. |
| 2 | **Privacy policy URL not set on the app** | human (host) + agent (draft) | Required to go Live AND to submit App Review. Needs a public URL (e.g. adsbyrex.com/privacy). |
| 3 | **App not in Live mode** | human | Flip after privacy policy + basic settings complete. |
| 4 | **Business verification status unknown** | human | Confirm in Business Settings → Security Center. Gates ads Advanced Access. |
| 5 | **App Review not submitted** (`ads_management`, `ads_read` Advanced Access) | human submits / agent preps | Needs screencast (§C of walkthrough) + use-case text (drafted, ready). |
| 6 | **`META_PAGE_ID` unset** (page id known) | agent | Quick add to `.env` = `1057312234142015`. Needed only to *launch* ads. |
| 7 | **`META_PIXEL_ID` unset** | optional | Only for conversion tracking. Defer unless wanted. |
| 8 | **M1/M2 git state** — M1 committed but unmerged; M2 WIP on same branch | decision | Untangle (A) vs. ship together (B). Not blocking the publish track. |

## Decisions needed to keep driving
- **DB (item 1):** local Postgres or a hosted URL you already have?
- **Privacy policy (item 2):** is one already hosted, or should I draft one for you to publish?

## Done-when (publish track complete)
- App in **Live** mode, privacy policy set, business **Verified**.
- `ads_management` + `ads_read` show **Advanced Access** (approved).
- Tool: a real Add-Client → Verify → observe-mode insights run recorded as the review screencast.

---

## Timeline / notes
- _(session start)_ Inventory complete. Credential half verified working against own account;
  remaining work is DB-to-run + the Meta publish/review steps. See blocker table above.
