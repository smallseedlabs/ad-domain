# Ads domain configuration and limitations

Engineering inventory. **Not** a product spec rewrite and **not** activation of live ads, research, or portal URL capture.

- **As of:** 2026-11-08
- **Scope:** this `ad-domain` checkout. Gitignored `.env` files were not read.

## 1. CURRENT VERIFIED

Internal Node 20 / TypeScript / Fastify service. Default bind `127.0.0.1:3800` (production host `0.0.0.0`). Inbound identity is a short-lived EdDSA JWT: signature, `iss` allowlist (default `proba-gateway`), `sub` allowlist (default `gateway`), `aud=proba-ads`, `exp`/`iat`, max TTL 120s, `jti`. Optional `workspaceId` claim, when present, must match the body. Current gateway mint for Ads tokens does **not** include `workspaceId`; body `workspaceId` is still required and scopes all rows.

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

- Live Reddit/Microsoft/Google/Meta adapters (later task). Credentials refused in this process.
- Hub → gateway → Ads end-to-end. Hub/LLM PRs from earlier workstreams stay unmerged; this repo does not retry them.
- Operator/portal destination URL field, protocol `create_goal` URL, research→sourced findings→user validation→create. Those are absent upstream. **Minimal future hook:** pass the user-entered URL as gateway tool arg `landingPageUrl` (already the Ads request field). Do not invent a research schema here.
- `workspaceId` on gateway-minted Ads tokens (compatible additive claim).
- Workload/workspace spend meshes, `$2` model caps, live automation delegation.
- Analytics bot.

## 3. npm audit (this checkout)

Recorded 2026-11-08 after a `tinypool@2.2.0` override (that removed two **dev** criticals). **`npm audit fix --force` was not used.** Test pass is not a security clearance.

Current `npm audit` (prod+dev): **15** advisories — **9 moderate, 5 high, 1 critical**.  
`npm audit --omit=dev` (production tree): **4 high, 0 critical** (`fastify`, `find-my-way`, `zod`, and `@smallseedlabs/proba-protocol` via `zod`).

| Package | Severity | Tree | Compatible fix attempted | Status |
| --- | --- | --- | --- | --- |
| `tinypool` (via vitest) | critical (2 GHSAs, prototype pollution in worker `run()` options) | **dev** | override `tinypool@2.2.0` (patched ≥2.1.2) without bumping vitest | **remediated** in lockfile (`npm ls` shows `tinypool@2.2.0 overridden`) |
| `vitest` ≤4.1.10 (`2.1.9` installed) | critical: “when Vitest UI server is listening, arbitrary file can be read and executed” plus nested mocker/vite | **dev** | npm’s only advertised fix is vitest **5.1.0** (semver major). Sibling stack is vitest 2; this repo runs `vitest run` (no UI server). | **unresolved**; reachability of the UI-server GHSA to CI/`vitest run` is **uncertain / likely low**, not proven absent. The nested `@vitest/mocker` path-traversal item is also unproven for this `vitest run` usage. |
| `fastify` 4.29.1 (latest 4.x) | high (rollup of several GHSAs, some individually low/moderate/high) | **prod** | npm’s fix is fastify **5.12.8** (breaking vs sibling Fastify 4 stack). No 4.x patch exists. | **unresolved**. Service is internal, `INGRESS_PUBLIC` refused, `trustProxy: false`, HTTP/2 not enabled, bodies validated with **zod** not Fastify schemas. Schema/HTTP2 CVEs are **probably not reachable**; Content-Type tab / not-found URL / async-validation collision items are **not ruled out**. |
| `find-my-way` 8.2.2 | high HTTP/2 DDoS | **prod** (fastify 4) | last 8.x; patched line is 9.7+. Overriding to 9.x is an untested Fastify 4 break. | **unresolved**; HTTP/2 is not enabled here, impact **uncertain** |
| `zod` 3.25.76 | high memory exhaustion on oversized constrained collections | **prod** (+ protocol) | fix is zod **≥4.6.6**; protocol v0.4.0 and the rest of Proba are zod 3. No compatible 3.x patch. | **unresolved**. Request bodies capped (`ADS_MAX_REQUEST_BYTES` default 262144). Whether that bound is enough against the GHSA is **unverified**. |
| `vite` (via vitest) | high (rollup; includes Windows `launch-editor` `fs.existsSync` bypass) | **dev** | advertised fix is vitest 5 / vite ≥6.4.4. Overriding vite 6 under vitest 2 is an untested break. | **unresolved**. Vite **dev server** is not this service’s runtime. The high Windows editor-flag item does not apply to this macOS/Linux Ads HTTP process; remaining vite path-traversal items apply to `vite`/test tooling, not proven in `vitest run`. |
| `@vitest/mocker` / `esbuild` / `vite-node` | moderate | **dev** | advertised as vitest 5 | **unresolved**; not the Ads HTTP process. esbuild “any website can talk to the dev server” assumes a listening esbuild/vite server. |
| `minimatch` 9 via typescript-eslint | moderate | **dev** | advertised “fix” installs parser **6.15.0** (semver **downgrade**/break) | **unresolved**; eslint-time only |

Do not treat this table as an exploitability proof.

## 4. Test vs real

| Kind | How | Spends ads? |
| --- | --- | --- |
| Unit / fake-store / fake-provider | `npm test` | no |
| Real Postgres schema `ads` | `ADS_TEST_DATABASE_URL` + `npm run test:integration` | no |
| Real Redis stream XADD | `ADS_TEST_REDIS_URL` | no |

Compose ports `127.0.0.1:55436` (Postgres) and `127.0.0.1:56381` (Redis) avoid sibling Proba maps. Do not point `DATABASE_URL` at Hub/Context/Memory databases without the `ads` schema isolation (migrations create `ads.*` only; they do not DROP sibling tables).
