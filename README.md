# ad-domain

Internal Ads domain HTTP service for Proba campaign identity, mapping, and fail-closed provider modules.

This repository previously contained only this stub. Task 4 adds the service foundation. It is **not** an end-to-end launch path: Hub/LLM publication is pending elsewhere, operator UI has no destination URL field, and provider adapters are unconfigured.

## What this process is

Gateway-only caller. Expected overlay hostname `ads`, port **3800**. Protocol audience remains `proba-ads` (the repo name does not change that).

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/health` | none. Process liveness. **Not** a billing claim. |
| GET | `/ready` | none. Postgres (and Redis when `AUDIT_PUBLISHER=redis`). **Not** billing. |
| POST | `/v1/preflight` | Bearer EdDSA `aud=proba-ads` |
| POST | `/v1/campaign-actions` | Bearer + `Idempotency-Key` |

Unauthorized requests are rejected before domain work.

`landingPageUrl` is a **request argument**. This service validates the string that arrived (http/https, no credentials, max length) and stores that exact value. It does **not** default, prefill, or fetch a destination. Upstream Hub/web/portal currently have no URL field and no research→create contract; a later integration should pass the user-entered URL into `args.landingPageUrl`. Until then, a present URL is not a validated user fact.

Provider adapters (Reddit/Microsoft/Google/Meta) are modules behind this domain. They are **unconfigured** in this slice. Mutations fail closed with `provider_unconfigured` and never report provider success. Test fakes exist only in `NODE_ENV=test` when injected.

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
| `[real-pg]` | `npm run test:integration` with `ADS_TEST_DATABASE_URL` | isolated Postgres schema `ads` |
| `[real-redis]` | same, with `ADS_TEST_REDIS_URL` | Redis `XADD` to a test stream |

This is **not** Hub → gateway → Ads end-to-end. Gateway/Hub merge work is out of this repo.

## License

Apache-2.0. Do not change license or repository visibility from this task.
