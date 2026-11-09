export const ADS_SERVICE_NAME = 'ads';

export type RuntimeEnv = 'development' | 'test' | 'production';
export type AuditPublisherKind = 'redis' | 'log';

export interface AdsServiceConfig {
  env: RuntimeEnv;
  logLevel: string;
  listen: { host: string; port: number };
  database: {
    url: string;
    schema: string;
    poolMin: number;
    poolMax: number;
  };
  auth: {
    gatewayPublicKeyFile: string;
    allowedIssuers: readonly string[];
    allowedSubjects: readonly string[];
  };
  audit: {
    kind: AuditPublisherKind;
    stream: string;
    redisUrl: string;
    contentEnabled: boolean;
    contentMaskPii: boolean;
    maxStreamLength: number;
    relayBatchSize: number;
    relayPollIntervalMs: number;
    relayLeaseMs: number;
  };
  limits: {
    maxRequestBytes: number;
    rateLimitMax: number;
    rateLimitWindowMs: number;
  };
  ads: {
    preflightFreshnessMs: number;
    maxDailyBudget: number | null;
    maxDailyBudgetCurrency: string | null;
    allowTestFakes: boolean;
    /** closed (default): well-formed researchAcceptance is not treated as Hub-accepted. shape is refused in production. */
    researchAcceptanceMode: 'closed' | 'shape' | 'gateway_attested';
  };
  reddit:
    | { enabled: false }
    | ({
        enabled: true;
        /** file: one static bearer token for one account (local debugging). */
        tokenSource: 'file';
        adAccountId: string;
        accessToken: string;
      } & RedditCommonConfig)
    | ({
        enabled: true;
        /** broker: short-lived tokens and the account from the Hub connection broker, per workspace. */
        tokenSource: 'broker';
        broker: ConnectionBrokerConfig;
      } & RedditCommonConfig);
}

export interface RedditCommonConfig {
  apiBaseUrl: string;
  timeoutMs: number;
  userAgent: string;
  conversionPixelId?: string;
  reportMaxPages?: number;
}

export interface ConnectionBrokerConfig {
  /** Hub base URL, e.g. http://hub:3000 (POST /v1/internal/connections/:provider/access-token). */
  url: string;
  allowedHosts: string[];
  /** Ed25519 PKCS#8 PEM; Ads signs iss proba-ads, aud proba-hub, sub ads. */
  privateKeyFile: string;
  keyId: string;
  timeoutMs: number;
}
