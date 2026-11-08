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

Recorded 2026-11-08 after this PR’s install on top of Ads PR2 (Fastify **5.12.8** / Vitest **5.1.0** / Vite **6.4.5**). `npm audit --omit=dev` → **0** vulnerabilities. Full tree (`prod+dev`): **6 moderate, 0 high, 0 critical** (`minimatch` via eslint 8 / typescript-eslint 7). **`npm audit fix --force` was not used.** `--legacy-peer-deps` was not used. Test pass is not a security clearance.

| Package | Severity | Tree | Compatible fix attempted | Status |
| --- | --- | --- | --- | --- |
| `fastify` | high (4.x rollup) | **prod** | upgraded to **5.12.8** in Ads PR2 | **remediated** (PR2) |
| `find-my-way` HTTP/2 DDoS | high | **prod** | Fastify 5 (`9.10.0` ≥ 9.7) | **remediated** (PR2) |
| `vitest` / `vite` / `tinypool` | critical/high/moderate | **dev** | Vitest **5.1.0** + Vite **6.4.5** in Ads PR2 | **remediated** (PR2) |
| `zod` collection memory exhaustion | high | **prod** | Ads `zod@^4.6.7` **with** protocol SHA below. No `overrides`. | **this PR** |
| `@smallseedlabs/proba-protocol` via Zod 3 | high | **prod** | pin unmerged protocol SHA (Zod 4.6.7 source). Not a `v0.6.0` tag. | **this PR**; tag still missing |
| `minimatch` 9.0.9 via typescript-eslint 7 / eslint 8 | moderate | **dev** | already latest 9.x. npm’s advertised “fix” is parser **6.15.0** (semver **downgrade**). | **unresolved**; eslint-time only |

Do not treat this table as an exploitability proof.

### 3.1 Protocol pin (unmerged SHA — not `v0.6.0`)

Protocol maintainers have **not** tagged or published `v0.6.0`. Pinning `github:smallseedlabs/proba-protocol#v0.6.0` would resolve to a **nonexistent tag** and is refused here.

Verified live heads (both open/mergeable; not tagged):

| Protocol PR | Head | Base |
| --- | --- | --- |
| [#22](https://github.com/smallseedlabs/proba-protocol/pull/22) research | `d043b2f584b0d631d58b7c34a34c44f4b44f8f4b` | `main` |
| [#23](https://github.com/smallseedlabs/proba-protocol/pull/23) Zod 4 source 0.6.0 | `298eeb4b4ba3fe14b4bf5077810ce2f433067984` | stacked on #22 |

This checkout pins **#23’s head**, not the superseded `e310475…` and not a nonexistent `v0.6.0` tag:

```
"@smallseedlabs/proba-protocol": "github:smallseedlabs/proba-protocol#298eeb4b4ba3fe14b4bf5077810ce2f433067984"
"zod": "^4.6.7"
```

That tree’s `package.json` is version **0.6.0** source (`zod@^4.6.7`, native `z.toJSONSchema(..., { target: "draft-07" })`, `validateAuditEvent` / `buildAuditEvent` names kept). It is **not** a release. npm installs that commit, not a tag. Protocol-side report: 255 local tests, 0 prod vulns, JSON Schema consumer fixture.

Rejected still:

| Option | Why not |
| --- | --- |
| `overrides: { "zod": "4.6.7" }` on protocol `v0.4.0` | Forces Zod 4 onto a Zod 3 protocol API. Incompatible. |
| Dual-major Ads Zod 4 + nested protocol Zod 3 | Two schema runtimes; prod audit would still report protocol’s Zod 3. |
| Edit `proba-protocol` / Hub / gateway / web in this run | Other workstream. Out of scope. |
| Pin `#v0.6.0` | Tag does not exist. |

**Release prerequisite (protocol owners, then a later Ads pin retarget):** merge protocol PR22 then PR23, tag `v0.6.0` (or whatever tag they choose) on a commit that is `298eeb4…` or a fast-forward of it, and only then change Ads to `github:smallseedlabs/proba-protocol#<tag>`. Until that tag exists, this SHA pin is the honest consumer dependency. Do not pin `e310475…` (superseded) or `#v0.6.0` (no such tag).

**Merge order for this Ads PR:** Ads [#2](https://github.com/smallseedlabs/ad-domain/pull/2) (Fastify/Vitest) first, then this PR. Reddit adapter [#3](https://github.com/smallseedlabs/ad-domain/pull/3) is a **separate** stack on #2 and is not a parent of this branch. Protocol PRs are user-merged in the protocol repo; this pin works while they stay open because the SHA is already on GitHub.

Local Zod 4 call-site updates in this service: `z.record(z.string(), z.unknown())`, `z.uuid()`, `z.iso.datetime()`, `code: "custom"`. Body-size limits remain a partial bound, not a substitute for the patched Zod line.

### 3.2 Task 5 (separate PR — Reddit module)

Not this PR. Reddit adapter work is [ad-domain #3](https://github.com/smallseedlabs/ad-domain/pull/3). First live adapter is Reddit (gateway `FIRST_AD_PLATFORMS` starts with `reddit`). Requirements that the foundation already encodes:

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
