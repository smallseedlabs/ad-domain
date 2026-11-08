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

- Live Reddit/Microsoft/Google/Meta adapters (Task 5+, queued). Credentials refused in this process.
- Hub → gateway → Ads end-to-end. Gateway PR3 is merged; Hub/web destination URL capture and research→create are still later. This repo does not retry Hub/web/protocol PRs.
- Operator/portal destination URL field, protocol `create_goal` URL, research→sourced findings→user validation→create. Those are absent upstream. **Minimal future hook:** pass the user-entered URL as gateway tool arg `landingPageUrl` (already the Ads request field). Do not invent a research schema here.
- `workspaceId` on gateway-minted Ads tokens (compatible additive claim).
- Workload/workspace spend meshes, `$2` model caps, live automation delegation.
- Analytics bot.

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

### 3.2 Task 5 (queued — Reddit module)

Not this PR. First live adapter is Reddit (gateway `FIRST_AD_PLATFORMS` starts with `reddit`). Requirements that the foundation already encodes:

- Implement `ProviderAdapter` for Reddit; default remains `UnconfiguredProvider` until that module is configured.
- Never report mutation `ok: true` without a real provider result. Uncertain outcomes stay `ambiguous` and are not retried as success.
- Create/resume/spend-increase still require verified billing; pause may skip ad-balance only. Billing `unknown` is not a verified zero.
- Credentials do not belong in this process until the adapter task; env keys for live networks are already refused at config load.
- `landingPageUrl` stays a request argument (no hardcoded/default destination).
- Tests: unit fakes vs isolated PG/Redis; **no live Reddit spend** in CI.

## 4. Test vs real

| Kind | How | Spends ads? |
| --- | --- | --- |
| Unit / fake-store / fake-provider | `npm test` | no |
| Real Postgres schema `ads` | `ADS_TEST_DATABASE_URL` + `npm run test:integration` | no |
| Real Redis stream XADD | `ADS_TEST_REDIS_URL` | no |

Compose ports `127.0.0.1:55436` (Postgres) and `127.0.0.1:56381` (Redis) avoid sibling Proba maps. Do not point `DATABASE_URL` at Hub/Context/Memory databases without the `ads` schema isolation (migrations create `ads.*` only; they do not DROP sibling tables).
