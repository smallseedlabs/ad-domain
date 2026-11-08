import { readFileSync } from 'node:fs';
import { ConfigError } from './errors.js';
import { DEFAULT_CALLER_ISSUERS, DEFAULT_CALLER_SUBJECTS } from './auth/constants.js';
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdsServiceConfig {
  if (env.REDDIT_CLIENT_SECRET || env.META_ACCESS_TOKEN || env.GOOGLE_ADS_DEVELOPER_TOKEN || env.MICROSOFT_ADS_CLIENT_SECRET) {
    throw new ConfigError('provider credentials do not belong in ad-domain env in this slice; adapters are unconfigured until a later task');
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
    },
  };
}
