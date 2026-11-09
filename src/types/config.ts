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
    | {
        enabled: true;
        adAccountId: string;
        accessToken: string;
        apiBaseUrl: string;
        timeoutMs: number;
        userAgent: string;
        conversionPixelId?: string;
        reportMaxPages?: number;
      };
}
