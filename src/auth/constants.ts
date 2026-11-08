/**
 * Inbound (gateway → Ads): audience is this service. Caller identity is the
 * verified issuer+subject allowlist (deployment-controlled; default gateway
 * only). Repo name `ad-domain` does not change the protocol audience.
 *
 * There is no service registry: keys are a local JWKS file.
 * Provider credentials do not belong here.
 */

export const ADS_AUDIENCE = 'proba-ads';
export const DEFAULT_CALLER_ISSUERS = ['proba-gateway'] as const;
export const DEFAULT_CALLER_SUBJECTS = ['gateway'] as const;

/** Service token lives at most two minutes (exp − iat), same as other Proba service tokens. */
export const SERVICE_TOKEN_MAX_TTL_SECONDS = 120;
/** Clock difference tolerated when checking exp, nbf and iat. */
export const CLOCK_SKEW_SECONDS = 30;

export const MAX_TOKEN_LENGTH = 8192;
export const MAX_JTI_LENGTH = 128;
