# ad-domain

Internal Ads domain HTTP service for Proba campaign identity, mapping, and fail-closed provider modules.

Internal Node 22.12+ / Fastify 5 / Vitest 5 service. Reddit Ads API v3 can be enabled **explicitly** (`REDDIT_ADS_ENABLED`); otherwise the process stays on `UnconfiguredProvider`. `landingPageUrl` is a request argument only. Zod is **4.6.7**, paired with released `proba-protocol#v0.6.0` (see `docs/CONFIGURATION_AND_LIMITATIONS.md`).

## What this process is

Gateway-only caller. Expected overlay hostname `ads`, port **3800**. Protocol audience remains `proba-ads` (the repo name does not change that).

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/health` | none. Process liveness. **Not** a billing claim. |
| GET | `/ready` | none. Postgres (and Redis when `AUDIT_PUBLISHER=redis`). **Not** billing. |
| POST | `/v1/preflight` | Bearer EdDSA `aud=proba-ads` |
| POST | `/v1/campaign-actions` | Bearer + `Idempotency-Key` |
| POST | `/v1/metrics-fetch` | Bearer + `Idempotency-Key`. Read-only Reddit reports → protocol `MetricObservation` + existing audit outbox. **Not** a campaign mutation. |

Unauthorized requests are rejected before domain work.

`landingPageUrl` is a **request argument**. This service validates the string that arrived (http/https, no credentials, max length) and stores that exact value. It does **not** default, prefill, or fetch a destination. On a Reddit **deliverable ad** create, that same string is sent as ad-level `click_url`. Campaign/ad-group scaffold without an ad is **not** a launch. Upstream Hub/web/portal currently have no URL field and no research→create contract; a later integration should pass the user-entered URL into `args.landingPageUrl`. Until then, a present URL is not a validated user fact. Create also requires `goalId`, a protocol `researchAcceptance` binding, and an existing Reddit `providerPostId` (`t3_…`). Ads does not create posts and does not call Hub to prove acceptance.

Provider adapters live in this process. The default is **unconfigured**. The Reddit v3 adapter is registered only when enabled with an ad account and token file; it talks to Reddit only through an injected HTTP transport (tests never open `ads-api.reddit.com`). Microsoft/Google/Meta stay unconfigured. Test fakes exist only in `NODE_ENV=test` when injected.

## Local run (no live ads)

```sh
npm ci
npm run typecheck
npm test                  # unit + in-process fakes; no Docker
```

Real isolated Postgres/Redis (does not use sibling Hub/Context ports):

```sh
npm ci
ADS_POSTGRES_PASSWORD=local-ads-test-only ./scripts/run-integration-local.sh
```

Then, to run the process itself:

```sh
# mint/test JWKS locally; production uses GATEWAY_SERVICE_PUBLIC_KEY_FILE
NODE_ENV=development \
  DATABASE_URL=postgres://ads:local-ads-test-only@127.0.0.1:55436/ad_domain \
  REDIS_URL=redis://127.0.0.1:56381 \
  AUDIT_PUBLISHER=log \
  GATEWAY_SERVICE_PUBLIC_KEY_FILE=/absolute/path/to/gateway.jwks.json \
  npm start
```

`AUDIT_PUBLISHER=log` is refused in production. See `docs/CONFIGURATION_AND_LIMITATIONS.md`.

## Tests

| Label | Command | Backing |
| --- | --- | --- |
| `[unit]` / `[fake-store]` / `[fake-provider]` | `npm test` | in-process MemoryStore, UnconfiguredProvider or injected FakeProvider. No network, no ad spend. |
| `[injected-http]` | included in `npm test` | `ScriptedHttpTransport` Reddit adapter. Never opens `ads-api.reddit.com`. |
| `[real-pg]` | `npm run test:integration` with `ADS_TEST_DATABASE_URL` | isolated Postgres schema `ads` |
| `[real-redis]` | same, with `ADS_TEST_REDIS_URL` | Redis `XADD` to a test stream |

This is **not** Hub → gateway → Ads end-to-end. Gateway/Hub merge work is out of this repo.

## License

Apache-2.0. Do not change license or repository visibility from this task.
