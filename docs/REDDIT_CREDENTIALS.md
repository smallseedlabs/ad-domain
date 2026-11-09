# Reddit Ads credentials: configuration and verification checklist

How to configure the in-process Reddit Ads adapter **without** committing
credentials, and how to verify each step before any spend. This document
contains no real credentials and none of these steps are executed by CI.

> Nothing here activates live ads. The adapter stays off unless
> `REDDIT_ADS_ENABLED=true` is set on a deployment the owner controls, and
> every spend-class command still needs Hub approval, accepted research and a
> verified billing claim.

Official references (read-only, checked 2026-11-09):
[Authenticate](https://ads-api.reddit.com/docs/v3/guides/quick-start/authenticate),
[Create a Reddit Application](https://business.reddithelp.com/s/article/Create-a-Reddit-Application),
[Reddit Ads API v3](https://ads-api.reddit.com/docs/v3/api/reddit-advertising-api).

## 1. What the owner creates (outside this repo)

1. A Reddit Ads account and a Business with a **verified business admin**
   (only business admins can manage developer applications).
2. A developer application in **Business → Developer Portal → Add Apps →
   Create an app**. Set a redirect URL on a domain you control. Keep the app ID
   and secret in your password manager. **Never** put them in this repo,
   `.env.example`, compose files, issues or PRs.
3. Authorize the app as the Reddit user who manages the ad account, with the
   smallest scopes Proba uses: `adsread,adsedit`. (`adsconversions` and
   `adsdatadeletion` are not called by Proba.)
4. Exchange the code for an access token on your own machine. Treat the
   access and refresh tokens as secrets.

Proba does **not** implement client-secret or refresh-token handling: setting
`REDDIT_CLIENT_SECRET` / `REDDIT_CLIENT_SECRET_FILE` refuses start. Tokens
expire (`expires_in` is typically 1 hour or 1 day); an expired token fails
closed with a 401 and must be rotated by the owner.

## 2. Configuration keys

| Key | Required | Notes |
| --- | --- | --- |
| `REDDIT_ADS_ENABLED` | yes, `true` to enable | default `false` (adapter not constructed) |
| `REDDIT_AD_ACCOUNT_ID` | yes when enabled | `a2_…`; commands for any other account are refused |
| `REDDIT_ACCESS_TOKEN_FILE` | yes in production | mounted secret file (e.g. `/run/secrets/reddit_access_token`); inline `REDDIT_ACCESS_TOKEN` is refused in production |
| `REDDIT_ACCESS_TOKEN` | non-production only | local experiments; never commit |
| `REDDIT_CONVERSION_PIXEL_ID` | yes before any create | Reddit requires a pixel on ad groups; invalid ids refuse start |
| `REDDIT_ADS_API_BASE_URL` | no | must be `https` in production |
| `REDDIT_HTTP_TIMEOUT_MS` | no | 500–60000, default 10000 |
| `REDDIT_USER_AGENT` | no | e.g. `web:proba-ads:0.1.0 (by /u/<your_username>)` |
| `REDDIT_REPORT_MAX_PAGES` | no | 1–50, default 10 |
| `ADS_RESEARCH_ACCEPTANCE_MODE` | no | `closed` (default) refuses create; `gateway_attested` accepts the signed gateway's accepted-research attestation for the exact URL; `shape` is refused in production |

Secrets belong in the private deployment configuration (Docker/Swarm secrets),
never in this public repository.

## 3. Verification checklist (owner, in order, no spend)

Run each step against a non-production deployment first. Stop at the first
failure.

- [ ] `npm test` passes locally (no network; Reddit is a scripted transport).
- [ ] Start with `REDDIT_ADS_ENABLED=false`: `/ready` is healthy and create
      returns `provider_unconfigured` (no provider call).
- [ ] Enable with the token **file** and account id: the process starts; with a
      missing file or a client secret it refuses start.
- [ ] `ads.provider_accounts` has exactly one `ready` row mapping your
      workspace to `REDDIT_AD_ACCOUNT_ID`.
- [ ] `POST /v1/preflight` for `reddit` reports `connection: ready`. Billing is
      `unknown` unless Reddit funding is actually verified; `unknown` must
      refuse create/resume/budget changes.
- [ ] Read-only metrics: `POST /v1/metrics-fetch` returns observations for the
      configured account only (`adsread`).
- [ ] A command naming a different `providerAccountId` is refused.
- [ ] Pause on a campaign you created manually in Reddit's UI and mapped to a
      Proba campaign works without a billing claim; resume is refused without
      verified billing.
- [ ] Create stays refused until: Hub approval, accepted research
      (`ADS_RESEARCH_ACCEPTANCE_MODE=gateway_attested` and a matching
      attestation), operator-approved creative, a user-entered landing URL
      (there is no default), the pixel id, and verified billing.
- [ ] Rotate the token: replace the secret file, restart, confirm preflight.
      Revoke the app's access in Reddit if a token may have leaked.
- [ ] Only after all of the above, and with an explicit owner decision on a
      daily budget cap (`ADS_MAX_DAILY_BUDGET`), consider a first live create.

## 4. What stays manual

- Creating the developer app, authorizing it, and storing/rotating tokens.
- Funding the Reddit Ads account.
- Deciding the first live campaign and its budget cap.
