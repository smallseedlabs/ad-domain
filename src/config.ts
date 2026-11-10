import { readFileSync } from 'node:fs';
import { ConfigError } from './errors.js';
import { DEFAULT_CALLER_ISSUERS, DEFAULT_CALLER_SUBJECTS } from './auth/constants.js';
import { REDDIT_ADS_API_BASE, REDDIT_USER_AGENT, redditConversionPixelId } from './providers/reddit/config.js';
import type { AdsServiceConfig, AuditPublisherKind, RuntimeEnv } from './types/config.js';

function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(raw);
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function envOptionalNumber(env: NodeJS.ProcessEnv, name: string): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new ConfigError(`${name} must be a positive number`);
  return parsed;
}

function envList(env: NodeJS.ProcessEnv, name: string, fallback: readonly string[]): string[] {
  const raw = env[name]?.trim();
  if (!raw) return [...fallback];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function envSecret(env: NodeJS.ProcessEnv, name: string): string {
  const filePath = env[`${name}_FILE`]?.trim();
  if (filePath) {
    try {
      return readFileSync(filePath, 'utf8').trim();
    } catch (err) {
      throw new ConfigError(`${name}_FILE is set but could not be read (${filePath}): ${(err as Error).message}`);
    }
  }
  return (env[name] ?? '').trim();
}

function runtimeEnv(raw: string | undefined): RuntimeEnv {
  const value = (raw ?? 'development').trim().toLowerCase();
  if (value === 'development' || value === 'test' || value === 'production') return value;
  throw new ConfigError(`NODE_ENV must be development, test or production (got "${raw}")`);
}

function schemaName(raw: string | undefined): string {
  const value = (raw ?? 'ads').trim();
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new ConfigError('DATABASE_SCHEMA must be a plain SQL identifier');
  return value;
}

function loadRedditConfig(env: NodeJS.ProcessEnv, nodeEnv: RuntimeEnv): AdsServiceConfig['reddit'] {
  if (env.REDDIT_CLIENT_SECRET || env.REDDIT_CLIENT_SECRET_FILE) {
    throw new ConfigError('Reddit client-secret / refresh is not implemented; configure a bearer access token only, via REDDIT_ACCESS_TOKEN_FILE');
  }
  const enabled = envBool(env, 'REDDIT_ADS_ENABLED', false);
  if (!enabled) return { enabled: false };
  const tokenSource = (env.REDDIT_TOKEN_SOURCE ?? 'file').trim().toLowerCase();
  if (tokenSource !== 'file' && tokenSource !== 'broker') throw new ConfigError('REDDIT_TOKEN_SOURCE must be file or broker');
  if (tokenSource === 'broker') return loadBrokeredRedditConfig(env, nodeEnv);
  const adAccountId = (env.REDDIT_AD_ACCOUNT_ID ?? '').trim();
  const accessToken = envSecret(env, 'REDDIT_ACCESS_TOKEN');
  if (!adAccountId) throw new ConfigError('REDDIT_AD_ACCOUNT_ID is required when REDDIT_ADS_ENABLED=true');
  if (!accessToken) {
    throw new ConfigError('REDDIT_ACCESS_TOKEN_FILE (or REDDIT_ACCESS_TOKEN) is required when REDDIT_ADS_ENABLED=true');
  }
  if (nodeEnv === 'production' && !(env.REDDIT_ACCESS_TOKEN_FILE ?? '').trim()) {
    throw new ConfigError('production Reddit adapter requires REDDIT_ACCESS_TOKEN_FILE; inline REDDIT_ACCESS_TOKEN is refused');
  }
  const apiBaseUrl = (env.REDDIT_ADS_API_BASE_URL ?? REDDIT_ADS_API_BASE).trim() || REDDIT_ADS_API_BASE;
  if (!apiBaseUrl.startsWith('https://') && nodeEnv === 'production') {
    throw new ConfigError('REDDIT_ADS_API_BASE_URL must be https in production');
  }
  const conversionPixelId = redditConversionPixelId(env.REDDIT_CONVERSION_PIXEL_ID);
  if ((env.REDDIT_CONVERSION_PIXEL_ID ?? '').trim() && !conversionPixelId) {
    throw new ConfigError('REDDIT_CONVERSION_PIXEL_ID is set but is not a valid Reddit pixel id');
  }
  return {
    enabled: true,
    tokenSource: 'file',
    adAccountId,
    accessToken,
    apiBaseUrl,
    timeoutMs: envInt(env, 'REDDIT_HTTP_TIMEOUT_MS', 10_000, 500, 60_000),
    userAgent: (env.REDDIT_USER_AGENT ?? REDDIT_USER_AGENT).trim() || REDDIT_USER_AGENT,
    conversionPixelId,
    reportMaxPages: envInt(env, 'REDDIT_REPORT_MAX_PAGES', 10, 1, 50),
  };
}

function redditCommon(env: NodeJS.ProcessEnv, nodeEnv: RuntimeEnv) {
  const apiBaseUrl = (env.REDDIT_ADS_API_BASE_URL ?? REDDIT_ADS_API_BASE).trim() || REDDIT_ADS_API_BASE;
  if (!apiBaseUrl.startsWith('https://') && nodeEnv === 'production') {
    throw new ConfigError('REDDIT_ADS_API_BASE_URL must be https in production');
  }
  const conversionPixelId = redditConversionPixelId(env.REDDIT_CONVERSION_PIXEL_ID);
  if ((env.REDDIT_CONVERSION_PIXEL_ID ?? '').trim() && !conversionPixelId) {
    throw new ConfigError('REDDIT_CONVERSION_PIXEL_ID is set but is not a valid Reddit pixel id');
  }
  return {
    apiBaseUrl,
    timeoutMs: envInt(env, 'REDDIT_HTTP_TIMEOUT_MS', 10_000, 500, 60_000),
    userAgent: (env.REDDIT_USER_AGENT ?? REDDIT_USER_AGENT).trim() || REDDIT_USER_AGENT,
    conversionPixelId,
    reportMaxPages: envInt(env, 'REDDIT_REPORT_MAX_PAGES', 10, 1, 50),
  };
}

/**
 * REDDIT_TOKEN_SOURCE=broker: no token or account in this service's environment. Each
 * provider call asks the Hub connection broker for the workspace's short-lived access token
 * and connected account. The client secret and refresh token never reach Ads.
 */
function loadBrokeredRedditConfig(env: NodeJS.ProcessEnv, nodeEnv: RuntimeEnv): AdsServiceConfig['reddit'] {
  if (env.REDDIT_ACCESS_TOKEN || env.REDDIT_ACCESS_TOKEN_FILE) {
    throw new ConfigError('REDDIT_TOKEN_SOURCE=broker gets tokens from the connection broker; unset REDDIT_ACCESS_TOKEN(_FILE)');
  }
  if ((env.REDDIT_AD_ACCOUNT_ID ?? '').trim()) {
    throw new ConfigError('REDDIT_TOKEN_SOURCE=broker uses the account chosen in Marketing; unset REDDIT_AD_ACCOUNT_ID');
  }
  const url = (env.CONNECTION_BROKER_URL ?? '').trim().replace(/\/+$/, '');
  if (!url) throw new ConfigError('CONNECTION_BROKER_URL is required when REDDIT_TOKEN_SOURCE=broker');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError('CONNECTION_BROKER_URL is not a URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ConfigError('CONNECTION_BROKER_URL must be http(s)');
  if (parsed.username || parsed.password) throw new ConfigError('CONNECTION_BROKER_URL must not carry credentials');
  const allowedHosts = envList(env, 'CONNECTION_BROKER_ALLOWED_HOSTS', []).map((h) => h.toLowerCase());
  if (nodeEnv === 'production' && allowedHosts.length === 0) {
    throw new ConfigError('CONNECTION_BROKER_ALLOWED_HOSTS is required in production (e.g. hub:3000)');
  }
  if (allowedHosts.length > 0 && !allowedHosts.includes(parsed.host.toLowerCase()) && !allowedHosts.includes(parsed.hostname.toLowerCase())) {
    throw new ConfigError(`CONNECTION_BROKER_URL host ${parsed.host} is not in CONNECTION_BROKER_ALLOWED_HOSTS`);
  }
  const privateKeyFile = (env.ADS_SERVICE_PRIVATE_KEY_FILE ?? '').trim();
  if (!privateKeyFile) throw new ConfigError('ADS_SERVICE_PRIVATE_KEY_FILE is required when REDDIT_TOKEN_SOURCE=broker');
  return {
    enabled: true,
    tokenSource: 'broker',
    broker: {
      url,
      allowedHosts,
      privateKeyFile,
      keyId: (env.ADS_SERVICE_KEY_ID ?? 'ads-svc-1').trim() || 'ads-svc-1',
      timeoutMs: envInt(env, 'CONNECTION_BROKER_TIMEOUT_MS', 5_000, 500, 30_000),
    },
    ...redditCommon(env, nodeEnv),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdsServiceConfig {
  if (env.META_ACCESS_TOKEN || env.GOOGLE_ADS_DEVELOPER_TOKEN || env.MICROSOFT_ADS_CLIENT_SECRET) {
    throw new ConfigError('Meta/Google/Microsoft credentials are refused; only the Reddit adapter can be enabled in this slice');
  }

  const nodeEnv = runtimeEnv(env.NODE_ENV);
  const publisherRaw = (env.AUDIT_PUBLISHER ?? (nodeEnv === 'production' ? 'redis' : 'log')).trim().toLowerCase();
  if (publisherRaw !== 'redis' && publisherRaw !== 'log') {
    throw new ConfigError(`AUDIT_PUBLISHER must be redis or log (got "${publisherRaw}")`);
  }
  const auditKind = publisherRaw as AuditPublisherKind;
  if (nodeEnv === 'production' && auditKind === 'log') {
    throw new ConfigError('AUDIT_PUBLISHER=log is not allowed when NODE_ENV=production');
  }

  const databaseUrl = envSecret(env, 'DATABASE_URL');
  const redisUrl = envSecret(env, 'REDIS_URL') || (env.REDIS_URL ?? '').trim();
  const gatewayPublicKeyFile = (env.GATEWAY_SERVICE_PUBLIC_KEY_FILE ?? '').trim();
  const allowTestFakes = envBool(env, 'ADS_ALLOW_TEST_FAKES', false);
  if (allowTestFakes && nodeEnv === 'production') {
    throw new ConfigError('ADS_ALLOW_TEST_FAKES is refused when NODE_ENV=production');
  }
  const researchAcceptanceModeRaw = (env.ADS_RESEARCH_ACCEPTANCE_MODE ?? 'closed').trim().toLowerCase();
  if (
    researchAcceptanceModeRaw !== 'closed' &&
    researchAcceptanceModeRaw !== 'shape' &&
    researchAcceptanceModeRaw !== 'gateway_attested'
  ) {
    throw new ConfigError('ADS_RESEARCH_ACCEPTANCE_MODE must be closed, shape or gateway_attested');
  }
  const researchAcceptanceMode = researchAcceptanceModeRaw as 'closed' | 'shape' | 'gateway_attested';
  if (nodeEnv === 'production' && researchAcceptanceMode === 'shape') {
    throw new ConfigError(
      'ADS_RESEARCH_ACCEPTANCE_MODE=shape is refused when NODE_ENV=production; Ads does not treat a well-formed binding as Hub-accepted'
    );
  }

  if (nodeEnv === 'production') {
    if (!databaseUrl) throw new ConfigError('DATABASE_URL or DATABASE_URL_FILE is required when NODE_ENV=production');
    if (!gatewayPublicKeyFile) throw new ConfigError('GATEWAY_SERVICE_PUBLIC_KEY_FILE is required when NODE_ENV=production');
    if (auditKind === 'redis' && !redisUrl) throw new ConfigError('REDIS_URL or REDIS_URL_FILE is required when AUDIT_PUBLISHER=redis');
  }

  if (env.INGRESS_PUBLIC?.trim() === 'true') {
    throw new ConfigError('INGRESS_PUBLIC=true is refused: ad-domain is an internal service with no public ingress default');
  }

  const host = (env.HOST ?? (nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1')).trim();
  const port = envInt(env, 'PORT', 3800, 1, 65535);
  const maxDailyBudgetCurrency = (env.ADS_MAX_DAILY_BUDGET_CURRENCY ?? '').trim().toUpperCase() || null;
  if (maxDailyBudgetCurrency && !/^[A-Z]{3}$/.test(maxDailyBudgetCurrency)) {
    throw new ConfigError('ADS_MAX_DAILY_BUDGET_CURRENCY must be a 3-letter code when set');
  }

  const reddit = loadRedditConfig(env, nodeEnv);
  const metricsSyncEnabled = envBool(env, 'ADS_METRICS_SYNC_ENABLED', false);
  if (metricsSyncEnabled && !reddit.enabled) {
    throw new ConfigError('ADS_METRICS_SYNC_ENABLED=true needs the Reddit adapter (REDDIT_ADS_ENABLED=true); nothing else can be synced');
  }

  return {
    env: nodeEnv,
    logLevel: (env.LOG_LEVEL ?? 'info').trim() || 'info',
    listen: { host, port },
    database: {
      url: databaseUrl,
      schema: schemaName(env.DATABASE_SCHEMA),
      poolMin: envInt(env, 'DATABASE_POOL_MIN', 0, 0, 16),
      poolMax: envInt(env, 'DATABASE_POOL_MAX', 10, 1, 64),
    },
    auth: {
      gatewayPublicKeyFile,
      allowedIssuers: envList(env, 'CALLER_ISSUERS', DEFAULT_CALLER_ISSUERS),
      allowedSubjects: envList(env, 'CALLER_SUBJECTS', DEFAULT_CALLER_SUBJECTS),
    },
    audit: {
      kind: auditKind,
      stream: (env.AUDIT_STREAM ?? 'proba.audit.events').trim() || 'proba.audit.events',
      redisUrl,
      contentEnabled: envBool(env, 'AUDIT_CONTENT_ENABLED', false),
      contentMaskPii: envBool(env, 'AUDIT_CONTENT_MASK_PII', true),
      maxStreamLength: envInt(env, 'AUDIT_MAX_STREAM_LENGTH', 100_000, 0, 10_000_000),
      relayBatchSize: envInt(env, 'AUDIT_RELAY_BATCH_SIZE', 100, 1, 1000),
      relayPollIntervalMs: envInt(env, 'AUDIT_RELAY_POLL_INTERVAL_MS', 500, 50, 60_000),
      relayLeaseMs: envInt(env, 'AUDIT_RELAY_LEASE_MS', 30_000, 1000, 300_000),
    },
    limits: {
      maxRequestBytes: envInt(env, 'ADS_MAX_REQUEST_BYTES', 262_144, 1024, 2_000_000),
      rateLimitMax: envInt(env, 'ADS_RATE_LIMIT_MAX', 60, 1, 10_000),
      rateLimitWindowMs: envInt(env, 'ADS_RATE_LIMIT_WINDOW_MS', 60_000, 1000, 3_600_000),
    },
    ads: {
      preflightFreshnessMs: envInt(env, 'ADS_PREFLIGHT_FRESHNESS_MS', 15_000, 1_000, 300_000),
      maxDailyBudget: envOptionalNumber(env, 'ADS_MAX_DAILY_BUDGET'),
      maxDailyBudgetCurrency,
      allowTestFakes,
      researchAcceptanceMode,
    },
    metricsSync: {
      enabled: metricsSyncEnabled,
      intervalMs: envInt(env, 'ADS_METRICS_SYNC_INTERVAL_SECONDS', 3600, 300, 86_400) * 1000,
      initialDelayMs: envInt(env, 'ADS_METRICS_SYNC_INITIAL_DELAY_SECONDS', 60, 0, 3600) * 1000,
      lookbackDays: envInt(env, 'ADS_METRICS_SYNC_LOOKBACK_DAYS', 2, 1, 30),
      maxCampaignsPerRun: envInt(env, 'ADS_METRICS_SYNC_MAX_CAMPAIGNS', 50, 1, 500),
    },
    reddit,
  };
}
