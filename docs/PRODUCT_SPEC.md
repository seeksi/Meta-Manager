# Meta Ads Manager — Product Spec / PRD (Phase 2)

Concise PRD per module. Builds on `ARCHITECTURE.md`. Format per module: user stories →
screens/flows + UI states → API endpoints → success metrics → edge cases.

UI states legend: **E** empty · **L** loading · **R** error · **S** success.

---

## 1. Meta API onboarding — `/settings/connection`
**Stories:** As the operator I connect my Meta app, paste/authorize a system-user token,
select the ad account, and verify Pixel/CAPI so the app can read insights and (later) write.
**Flow:** connect app → authorize token → pick ad account → verify Pixel + CAPI event →
status: Connected. States: **E** "Not connected" CTA · **L** verifying · **R** invalid
token/scope, missing permission · **S** Connected w/ account name + scopes.
**Endpoints:** `POST /api/connection/token`, `GET /api/connection/status`,
`POST /api/connection/verify-capi`.
**Metrics:** time-to-connect < 5 min; verified CAPI event received.
**Edge:** token expired/revoked; missing scope; app still in review (stub flow, clear TODO);
multiple ad accounts.

## 2. Metrics monitoring & display — `/` dashboard
**Stories:** I see live KPIs (spend, CPM, CPC, CTR, CPA, ROAS, frequency, CPL, learning
phase) with a date-range filter and can drill into a campaign.
**Flow:** dashboard loads from DB rollups → filter date range → click campaign → drilldown.
States: **E** no data yet / not connected · **L** skeleton cards · **R** stale-data banner
("last synced 22m ago") · **S** cards + charts + freshness badge.
**Endpoints:** `GET /api/metrics/summary?range=`, `GET /api/metrics/timeseries?entity=`,
`GET /api/metrics/freshness`. (Reads DB only — never live Meta on load.)
**Metrics:** dashboard p95 < 1s; freshness within cadence SLA.
**Edge:** attribution shifts on recent windows; missing days; zero-spend; currency formatting.

## 3. Budget management — `/campaigns/[id]`
**Stories:** I view and adjust a campaign/ad-set budget; changes route through the executor
and respect guardrails; Tier B amounts queue for approval.
**Flow:** open campaign → edit budget (absolute value) → guardrail preview (allow / needs
approval / blocked + reason + projected daily spend) → confirm → action created.
States: **E** no campaigns · **L** loading · **R** guardrail block w/ reason / write failed ·
**S** "Applied" or "Queued for approval".
**Endpoints:** `GET /api/campaigns`, `GET /api/campaigns/:id`,
`POST /api/actions` (proposes a `set_budget` action; executor writes).
**Metrics:** zero unintended overspends; % budget changes auto vs approval.
**Edge:** stale metrics block increases; cap exceeded; concurrent edits; Meta write timeout → `uncertain`.

## 4. Creative & ad upload/assembly — `/creatives` + `/ads/new`
**Stories:** I upload images/video to a library, then assemble an ad (creative + copy + CTA
+ destination), preview it, and queue it to launch (Tier B → approval).
**Flow:** upload → Blob store + metadata + hash → pick creative in ad builder → add copy/CTA/
URL → preview → "Queue launch". States: **E** empty library · **L** uploading (progress) ·
**R** unsupported format / too large / upload failed · **S** asset saved / ad queued.
**Endpoints:** `POST /api/creatives` (Blob upload), `GET /api/creatives`,
`POST /api/ads` (assemble), `POST /api/actions` (launch_ad → approval).
**Metrics:** upload success rate; ads assembled per week; spec-valid creatives %.
**Edge:** dup upload (hash dedup); video transcode/spec mismatch; Meta creative rejection; orphaned Blob on failure.

## 5. AI copywriting — inline in `/ads/new`
**Stories:** I generate headline/primary-text/CTA variants conditioned on brand voice,
edit them, and attach to the ad.
**Flow:** enter brief/product → generate (structured output) → view N variants → edit/select
→ attach. States: **E** prompt empty · **L** generating · **R** model/gateway error,
char-limit violation flagged · **S** variants shown, selected one attached.
**Endpoints:** `POST /api/copy/generate` (AI SDK via Gateway, `Output.object` schema).
**Metrics:** generation success; % ads using generated copy; char-spec pass rate.
**Edge:** Meta char limits per placement; banned-claim flags; gateway rate limit/timeout; empty/low-quality output.

## 6. Lead funnel management — `/leads`
**Stories:** I capture leads, see pipeline stages, and view funnel analytics (volume,
stage conversion, CPL by campaign).
**Flow:** lead ingested → assigned stage → funnel view → drill by source/campaign. States:
**E** no leads · **L** loading · **R** ingest error · **S** pipeline + funnel chart.
**Endpoints:** `POST /api/leads` (capture/webhook), `GET /api/leads`, `PATCH /api/leads/:id` (stage),
`GET /api/leads/funnel`.
**Metrics:** capture reliability; stage conversion rates; CPL trend.
**Edge:** spam/bot leads; dedup; missing attribution; webhook retries (idempotency).

## 7. Competitor creative research — `/research`
**Stories:** I browse competitor ads from the Meta Ad Library, save winners, tag reusable
patterns, and surface long-running ads.
**Flow:** search advertiser/keyword → ingest (Ad Library API + Apify actor) → browse →
save + tag patterns. States: **E** no searches · **L** ingesting · **R** rate-limited / no
results · **S** results grid w/ run-duration badges.
**Endpoints:** `POST /api/research/ingest`, `GET /api/research/creatives`,
`POST /api/research/:id/tags`.
**Metrics:** competitors tracked; patterns catalogued; long-runners flagged.
**Edge:** Ad Library coverage gaps; scraper throttling; media expiry; ToS-safe usage (inspiration, not copying).

## 8. Settings optimization & auto-launch — `/optimize`
**Stories:** I review optimizer recommendations; Tier A auto-executes within caps, Tier B
shows a diff + projected cost for one-click approve/reject.
**Flow:** optimization_run produces proposals → list w/ evidence → Tier A shown as
auto-applied (audited), Tier B awaiting approval → approve/reject. States: **E** no proposals
· **L** running · **R** run failed (default-deny) · **S** proposals w/ statuses.
**Endpoints:** `GET /api/optimize/proposals`, `POST /api/actions/:id/approve`,
`POST /api/actions/:id/reject`.
**Metrics:** proposal acceptance rate; spend efficiency lift; zero guardrail breaches.
**Edge:** stale metrics → block; policy version changed → block; approval expiry → re-check; conflicting proposals.

## 9. Lead conversion / monitoring / retention — `/leads` (lifecycle)
**Stories:** I score leads, trigger nurture sequences, and track retention/lifecycle.
**Flow:** lead scored → lifecycle stage → nurture trigger (email-sequence) → retention view.
States: **E** no lifecycle data · **L** loading · **R** trigger failure · **S** scored
pipeline + retention chart.
**Endpoints:** `GET /api/leads/:id/score`, `POST /api/leads/:id/nurture`, `GET /api/leads/retention`.
**Metrics:** lead→customer conversion; nurture engagement; retention/repeat rate.
**Edge:** scoring cold-start; over-messaging guardrails; unsubscribe handling; attribution gaps.

---

## Cross-cutting: Autonomy control — `/automation`
**Stories:** I set write-mode and caps, hit the kill-switch, work the approval queue, and
read the audit log.
**Screens:** controls panel (write_mode, caps, freshness), **kill-switch** (header-global),
approval queue (diff + projected cost), audit log (filterable timeline).
**Endpoints:** `GET/PATCH /api/automation/control`, `POST /api/automation/kill`,
`GET /api/automation/queue`, `GET /api/audit`.
**Metrics:** kill-switch < 1s effective; 100% spend actions audited; zero unaudited writes.
**Edge:** control row read failure → default-deny everywhere; policy-version bump invalidates pending approvals.

---
skipped: per-module analytics depth (v2), A/B testing UI — add when core loop is live.
