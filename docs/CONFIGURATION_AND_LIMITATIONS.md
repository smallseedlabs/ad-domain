# Ads domain configuration and limitations

Engineering inventory. **Not** a product spec rewrite and **not** activation of live ads, research, or portal URL capture.

- **As of:** 2026-11-08
- **Scope:** this `ad-domain` checkout. Gitignored `.env` files were not read.

## 1. CURRENT VERIFIED

Internal Node **22.12+** / TypeScript / **Fastify 5** service (this process; sibling Hub/gateway may still be Fastify 4 / Node 20). Vitest 5.1.0’s engine is `^22.12.0 || ^24 || >=26`; Fastify 5.12.8 pulls `cookie@2` (`engines.node >=22`) via `light-my-request`. The image and CI track that floor so tests are not run on an unsupported Node. Default bind `127.0.0.1:3800` (production host `0.0.0.0`). Inbound identity is a short-lived EdDSA JWT: signature, `iss` allowlist (default `proba-gateway`), `sub` allowlist (default `gateway`), `aud=proba-ads`, `exp`/`iat`, max TTL 120s, `jti`. Optional `workspaceId` claim, when present, must match the body. Current gateway mint for Ads tokens does **not** include `workspaceId`; body `workspaceId` is still required and scopes all rows.

| Key | Default | Range / notes | Unknown / fail |
| --- | --- | --- | --- |
| `PORT` | `3800` | 1–65535 | |
| `CALLER_ISSUERS` / `SUBJECTS` | `proba-gateway` / `gateway` | lists | 401 before work |
| `GATEWAY_SERVICE_PUBLIC_KEY_FILE` | empty; required in production | JWKS, public keys only | refuse start |
| `DATABASE_URL` | empty; required outside test | isolated schema `ads` | `/ready` fail |
| `DATABASE_SCHEMA` | `ads` | SQL identifier | |
| `AUDIT_PUBLISHER` | `log` in non-prod; `redis` in production | `log` refused in production | |
| `AUDIT_STREAM` | `proba.audit.events` | existing durable stream | relay at-least-once |
| `REDIS_URL` | empty; required for redis publisher in production | | `/ready` fail |
| `ADS_PREFLIGHT_FRESHNESS_MS` | `15000` | 1000–300000 | |
| `ADS_MAX_DAILY_BUDGET` | **unset (`null`)** | positive number if set | **not $2** |
| `ADS_ALLOW_TEST_FAKES` | `false` | refused in production | FakeProvider inject only |
| `INGRESS_PUBLIC=true` | refused | | |

Health `/health` and readiness `/ready` do **not** query provider balances.

Create / resume / spend-increase require auth scope, any configured numeric cap, and a **verified** billing claim. Pause may skip **ad-balance only**. Unconfigured adapters report billing `unknown` and refuse spend-increase. Absent provider **never** returns `ok: true`.

Campaign rows store the request `landingPageUrl` verbatim after syntactic checks. There is no fallback URL.

Idempotency ledger: `(workspace_id, idempotency_key)`. Same args replay stored results. Different args → 409. In-flight / ambiguous keys are not retried (crash between side effect and commit is recorded, not claimed exactly-once).

Audit: domain writes and `ads.audit_outbox` share a transaction. Relay `XADD`s protocol `AuditEvent` JSON to `proba.audit.events`. Replay of that stream must **never** execute commands. Secrets are redacted from `details`.

## 2. Not built / not claimed

- Microsoft/Google/Meta adapters. Reddit v3 is in-process and **off** unless `REDDIT_ADS_ENABLED=true` with account + token file.
- Hub → gateway → Ads end-to-end. Gateway PR3 is merged; Hub/web destination URL capture and research→create are still later. This repo does not retry Hub/web/protocol PRs. Gateway “accepted artifact” guard is an **upstream** requirement, not built here.
- Operator/portal destination URL field, protocol `create_goal` URL, research→sourced findings→user validation→create. Those are absent upstream. **Minimal future hook:** pass the user-entered URL as gateway tool arg `landingPageUrl` (already the Ads request field). Do not invent a research schema here.
- `workspaceId` on gateway-minted Ads tokens (compatible additive claim).
- Workload/workspace spend meshes, `$2` model caps, live automation delegation.
- Analytics bot / Hub query UI. This slice can **fetch** Reddit reports into protocol `MetricObservation`s and emit them on the existing audit outbox (`POST /v1/metrics-fetch`). It does not store a metrics table, run the audit ingester, or expose a query UI.

## 3. npm audit (this checkout)

Recorded 2026-11-08 after a **tested** Fastify **5.12.8** + Vitest **5.1.0** + Vite **6.4.5** upgrade on this service. Sibling Fastify 4 / Vitest 2 stacks were **not** used as a reason to keep known-vulnerable majors here. **`npm audit fix --force` was not used.** `--legacy-peer-deps` was not used. Test pass is not a security clearance.

Current `npm audit` (prod+dev): **8** advisories — **6 moderate, 2 high, 0 critical**.  
`npm audit --omit=dev` (production tree): **2 high, 0 critical** (`zod@3.25.76` and `@smallseedlabs/proba-protocol@0.4.0` via `zod`).

| Package | Severity | Tree | Compatible fix attempted | Status |
| --- | --- | --- | --- | --- |
| `fastify` | high (4.x rollup) | **prod** | upgraded to **5.12.8** (`find-my-way@9.10.0`). HTTP surface is `inject`/`listen({host,port})`, `logger: false`, `trustProxy: false`, no Fastify JSON schemas. Runtime/CI/image moved to Node **22.12+** with this upgrade. | **remediated** |
| `find-my-way` HTTP/2 DDoS | high | **prod** | comes in with Fastify 5 (9.10.0 ≥ 9.7) | **remediated** |
| `vitest` UI-server arbitrary file read/exec | critical | **dev** | upgraded to **5.1.0** (npm’s patched line). Peer Vite resolved with direct `vite@^6.4.5` (patched ≥6.4.4) and `@types/node@^22` (types only; runtime engine remains Node ≥20). | **remediated** |
| `vite` / `@vitest/mocker` / `esbuild` / `vite-node` / `tinypool` | high/moderate/critical | **dev** | pulled by Vitest 5 + Vite 6.4.5; `tinypool` is no longer in this tree | **remediated** in current lockfile |
| `zod` 3.25.76 | high: collection memory exhaustion | **prod** (+ protocol) | **not upgraded.** See §3.1. Body cap `ADS_MAX_REQUEST_BYTES` default 262144 is a partial bound, **unverified** vs the GHSA. | **unresolved**; blocked on protocol |
| `@smallseedlabs/proba-protocol` | high via `zod` | **prod** | no ads-only compatible fix | **unresolved**; blocked on protocol |
| `minimatch` 9.0.9 via typescript-eslint 7 / eslint 8 | moderate | **dev** | already latest 9.x. npm’s advertised “fix” is parser **6.15.0** (semver **downgrade**). A real path is eslint 9 + typescript-eslint 8 (lint-stack major, not this PR). | **unresolved**; eslint-time only |

Do not treat this table as an exploitability proof.

### 3.1 Zod / protocol prerequisite (why Ads cannot take Zod 4 in this PR)

Pinned dependency: `github:smallseedlabs/proba-protocol#v0.4.0` (`@smallseedlabs/proba-protocol@0.4.0`). That package’s `package.json` depends on:

- `zod@^3.23.8` (Zod **3** API)
- `zod-to-json-schema@^3.23.3` (Zod **3** only; used by `scripts/generate-schemas.js`)

Protocol TypeScript schemas (`src/schemas/audit.ts`, `command.ts`, `event.ts`, `ui.ts`, `metrics.ts`, `context.ts`) `import { z } from 'zod'`. Ads imports `validateAuditEvent` / `buildAuditEvent` from that package and also uses Zod 3 locally (`z.record(z.unknown())`, `z.string().datetime()`, `z.ZodIssueCode.custom`) so HTTP and audit validation share one major.

Options that were **rejected** here (incompatible or incomplete):

| Option | Why not in this PR |
| --- | --- |
| `overrides: { "zod": "4.6.6" }` | Forces protocol onto Zod 4’s default export. That is a different API (`z.record` arity, JSON schema helper, issue codes). It is an incompatible resolution, not a supported upgrade. |
| `npm audit fix --force` | Would also move Fastify/Vitest/eslint along npm’s breakages without a tested tree. Already done Fastify/Vitest **with tests** instead. |
| Dual-major: Ads on Zod 4, nested protocol on Zod 3 | Two schema runtimes in one process. Production `npm audit --omit=dev` would **still** report protocol’s nested Zod 3. Does not clear the remaining highs. |
| Edit `proba-protocol` in this run | Other workstream owns protocol/gateway/hub/web. Out of scope. |

**Upstream prerequisite (protocol workstream, then a follow-up Ads bump):**

1. Publish a protocol version that depends on **`zod@>=4.6.6`** (the GHSA patched line; 4.6.7 is current).
2. Replace **`zod-to-json-schema`** (no Zod 4 support) with Zod 4’s `z.toJSONSchema()` (or another Zod 4-capable generator) in `scripts/generate-schemas.js`.
3. Tag that release (for example `v0.5.0` — exact tag is the protocol owners’). Regenerated `schemas/*.json` must stay compatible with existing audit consumers.
4. Ads then changes `"@smallseedlabs/proba-protocol": "github:smallseedlabs/proba-protocol#<new-tag>"` **and** `"zod": "^4.6.6"` together, and updates local schemas (`z.record(z.string(), z.unknown())`, datetime helpers, issue codes).

Until that tag exists, keeping Ads on Zod 3 aligned with protocol v0.4.0 is the compatibility-safe option. Body-size limits are **not** a substitute for the patched Zod line.

## 4. Test vs real

| Kind | How | Spends ads? |
| --- | --- | --- |
| Unit / fake-store / fake-provider | `npm test` | no |
| Reddit adapter (injected HTTP) | `ScriptedHttpTransport` | no live Reddit |
| Real Postgres schema `ads` | `ADS_TEST_DATABASE_URL` + `npm run test:integration` | no |
| Real Redis stream XADD | `ADS_TEST_REDIS_URL` | no |

Compose ports `127.0.0.1:55436` (Postgres) and `127.0.0.1:56381` (Redis) avoid sibling Proba maps. Do not point `DATABASE_URL` at Hub/Context/Memory databases without the `ads` schema isolation (migrations create `ads.*` only; they do not DROP sibling tables).

## 5. Reddit Ads adapter (Task 5)

In-process module, not a separate deployment. Default remains `UnconfiguredProvider`. The Reddit adapter is constructed only when `REDDIT_ADS_ENABLED=true` **and** `REDDIT_AD_ACCOUNT_ID` plus `REDDIT_ACCESS_TOKEN_FILE` (production) or `REDDIT_ACCESS_TOKEN` (non-production) are set. Incomplete enablement refuses process start. Client-secret / refresh is **not** implemented (`REDDIT_CLIENT_SECRET` is refused). Token expiry surfaces as 401 fail-closed.

Public docs used (read-only, 2026-11-08): [Reddit Advertising API v3](https://ads-api.reddit.com/docs/v3/api/reddit-advertising-api), [Create Campaign](https://ads-api.reddit.com/docs/v3/api/create-campaign), [Create Ad Group](https://ads-api.reddit.com/docs/v3/api/create-ad-group), [Update Campaign](https://ads-api.reddit.com/docs/v3/api/update-campaign), [List Funding Instruments](https://ads-api.reddit.com/docs/v3/api/list-funding-instruments). v2 is sunset except CAPI.

### Operational

```
REDDIT_ADS_ENABLED=true
REDDIT_AD_ACCOUNT_ID=a2_…
REDDIT_ACCESS_TOKEN_FILE=/run/secrets/reddit_access_token
# required before any create (all ad groups since 2026-07-13):
REDDIT_CONVERSION_PIXEL_ID=t2_…
# optional:
# REDDIT_ADS_API_BASE_URL=https://ads-api.reddit.com/api/v3
# REDDIT_HTTP_TIMEOUT_MS=10000
# REDDIT_USER_AGENT=web:proba-ads:0.1.0 (by /u/your_reddit_username)
# REDDIT_REPORT_MAX_PAGES=10
```

Workspace rows still require a ready `ads.provider_accounts` mapping for that Reddit account. Commands that name a different `providerAccountId` are refused. Pause/resume/update GET the remote campaign and refuse if `ad_account_id` is not the configured account. Cross-provider transfers are not implemented.

`landingPageUrl` is the request argument (fixture `https://example.test/offer` in tests). It is stored on the Proba campaign. Reddit `click_url` is **ad-level**; this slice does not create ads, posts, or creatives, so the URL is **not** pushed to Reddit as a destination. No SmallSeed/marketing URL is defaulted.

**Create semantics (scaffold, not a launch).** A successful `ads.create_campaign` on Reddit is a **campaign + ad-group scaffold** only. It is **not** a deliverable ad, not a creative, and not a destination `click_url`. The HTTP result sets `providerLaunch: campaign_ad_group_scaffold`, `deliverableAd: false`, `clickUrlPushed: false`, `missingProviderEntities: [ad, creative, click_url]`. Local campaign status stays `draft`. Preflight `running` is true only when a `providerAdId` exists. Do not treat `ok: true` as a runnable campaign launch.

**Remaining contract to actually launch:** Reddit Ad + Creative (or Structured Post) with `click_url` = the user-entered landing URL, plus any required targeting/schedule. Those inputs are **not** in the current Ads create args and are **not** invented here. Gateway/Hub URL capture remains upstream.

**Mandatory create prerequisite:** `REDDIT_CONVERSION_PIXEL_ID` (valid pixel id). As of 2026-07-13 this is required on **all** ad groups. Missing or invalid pixel → `provider_prerequisites_missing` **before any POST/PATCH**. Pause/resume may run without a pixel. Process start still allows enablement without a pixel so pause-only operators are not blocked.

Create/resume/spend-increase still require a **verified eligible** billing claim. Pause may skip ad-balance only. `/health` and `/ready` still do not query Reddit billing.

### Billing (fail closed)

`GET /ad_accounts/{id}/funding_instruments?mode=SELECTABLE` (`ads-funding-instruments`). This process does **not** follow `pagination.next_url`.

| HTTP / parse | Claim |
| --- | --- |
| 200 + at least one `is_servable=true` on the first page | `verified` / `billing_eligibility` / `eligible: true`. **Not** `exact_balance`. `billable_amount` is outstanding debt, not cash on hand. `credit_limit` is not treated as a spendable balance. |
| 200 + none servable and no `next_url` | `verified` / `eligible: false` |
| 200 + none servable and `pagination.next_url` present | `unknown` — incomplete page, **not** a verified zero |
| 401/403 | `unavailable` |
| 404, 429, 5xx, timeout, non-JSON | `unknown` — **not** a verified zero. Spend-increase refused. |

### Mutations (v3)

- Create (only after pixel + billing eligibility): `POST /ad_accounts/{id}/campaigns` with `objective=CLICKS`, `configured_status=ACTIVE`, `funding_instrument_id` from a servable instrument. Then `POST .../ad_groups` with `type=MANUAL`, `goal_type=DAILY_SPEND`, `goal_value` in **microcurrency** (`major * 1_000_000`), `bid_type=CPC`, `bid_strategy=BIDLESS`, `conversion_pixel_id` from config. Campaign-budget-optimization is **not** used. The result is still only a scaffold (no ad/creative/`click_url`).
- Pause/resume: `PATCH /campaigns/{id}` `configured_status` `PAUSED`/`ACTIVE` after a GET ownership check. Pause does **not** query funding instruments.
- Daily budget update: `PATCH /ad_groups/{id}` `goal_value` micros. Name-only updates skip an empty campaign PATCH. Refused if no ad-group mapping.
- 429: `provider_rate_limited`, **no retry**.
- Timeout / 5xx on POST/PATCH: `outcome_ambiguous`, persisted, not retried as success.
- Certain 4xx on ad-group create after a campaign id was returned: campaign mapping is persisted (so a retry does not create a second campaign); `providerAdGroupId` stays unset and remote daily budget is **not** claimed.

### API assumptions and unknowns

- Ad account ids look like `a2_…` / `t2_…` per docs. Not re-validated beyond “configured string matches command mapping”.
- Minimal create body omits targeting/schedule/special ad categories. Reddit may 400; that is refused, not spoofed as success.
- Funding-instrument 404 is treated as **unknown billing**, because we cannot prove the account has no funds.
- As of 2026-07-13, official Create Ad Group docs require `conversion_pixel_id` for **all** ad groups. Missing/invalid `REDDIT_CONVERSION_PIXEL_ID` fails **before** any create POST. This process does **not** POST a campaign and then treat an expected 400 as documentation.
- Create Ad Group’s example `goal_value: 75` disagrees with the field text (“microcurrency for monetary goal types”). This adapter sends micros (`12` → `12000000`). Live 400 on that field is refused, not retried as success.
- Default User-Agent is `web:proba-ads:0.1.0 (internal Ads domain; no public user)`. Reddit asks for `platform:app:version (by /u/username)`. Operators should set `REDDIT_USER_AGENT` with a real Reddit username; this process will not invent one.
- No OAuth refresh; operators rotate `REDDIT_ACCESS_TOKEN_FILE`. Token expiry is 401 fail-closed.
- Microsoft/Google/Meta remain unconfigured.
- Protocol Zod 4 is a **separate** workstream; this PR does not override zod.
- Gateway “accepted artifact” guard and Hub/web destination URL capture remain **upstream**. This slice does not claim a built operator UI.

Tests inject `ScriptedHttpTransport`. CI and local tests must not call `ads-api.reddit.com`.

## 6. Reddit analytics (Task 6 — read-only)

Official [Get a Report](https://ads-api.reddit.com/docs/v3/api/get-a-report) (`POST /ad_accounts/{id}/reports`, policy `ads-reporting`). This is a **read**. It does not create, pause, resume, or patch campaigns/ad groups/ads. Billing is not queried.

`POST /v1/metrics-fetch` (gateway JWT + `Idempotency-Key`) loads the workspace/user/account/campaign mapping, `GET`s the remote campaign for ownership, then requests the report. Results are normalised with `validateMetricObservation` and written to `ads.audit_outbox` as protocol actions `metrics.fetch_started`, `metrics.ingested`, `campaign.metrics_attributed`, `metrics.fetch_completed` (or `metrics.fetch_failed`). Relay still `XADD`s `proba.audit.events`. There is **no** Ads metrics table and **no** second bus.

| Mapping | Protocol `MetricObservation` |
| --- | --- |
| `IMPRESSIONS` / `CLICKS` | required ints; **null → quarantine, never 0** |
| `SPEND` | divide by **1e6** (official microcurrency) |
| `KEY_CONVERSION_TOTAL_COUNT` | required protocol `conversions`. Reddit field is **nullable**. Null/absent is quarantined with that prerequisite; **not** stored as 0 |
| `CURRENCY` | ISO 4217 length 3; missing quarantined |
| `DATE` / `DATETIME` | UTC day or hour bounds (`timezone: UTC` only in this slice) |
| `REACH` / `VIDEO_VIEWABLE_IMPRESSIONS` | optional; omitted when absent |
| `pagination.next_url` | followed only on the configured Ads API origin, cap `REDDIT_REPORT_MAX_PAGES` (default 10). Over-cap / off-origin / mid-window page failure → fetch **fails**; unread pages are **not** zeros |

`filter=campaign:id=={mapped}`. Rows for any other `campaign_id` are quarantined. `time_zone_id=UTC` always. Non-UTC request timezone is refused so period bounds are not guessed.

Campaign status/budget/mappings are not updated. Command ledger verb is `ads.fetch_metrics` (separate from `/v1/campaign-actions`).

### Remaining gaps

- Protocol `MetricValues.conversions` is required; Reddit conversion metrics are nullable. Rows without `KEY_CONVERSION_TOTAL_COUNT` cannot become observations.
- Non-UTC Reddit reporting timezones are not mapped (local-midnight math not invented here).
- Hour windows longer than 7 days and day windows longer than 31 days are refused.
- Ads does not persist observations in Postgres; the durable copy is the audit stream for proba-audit/ClickHouse.
- Live Reddit E2E is **not** claimed. Microsoft/Google/Meta analytics are unconfigured.
