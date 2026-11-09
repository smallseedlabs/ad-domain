import pg from 'pg';
import type { JWTVerifyGetKey } from 'jose';
import { ConfigError } from './errors.js';
import { loadPublicKeySet } from './auth/public-key-set.js';
import { ServiceTokenAuth } from './auth/service-token.js';
import { LogAuditPublisher, RedisAuditPublisher } from './audit/publisher.js';
import { OutboxRelay } from './audit/relay.js';
import { runMigrations } from './db/migrate.js';
import { createLogger, type Logger } from './logger.js';
import { SystemClock, type Clock } from './ports/clock.js';
import type { AuditPublisher } from './ports/audit-publisher.js';
import type { ServiceAuth } from './ports/auth.js';
import type { ProviderAdapter } from './providers/port.js';
import { FetchHttpTransport } from './providers/http.js';
import { CredentialedRedditAdapter } from './providers/reddit/brokered-adapter.js';
import { BrokerCredentialSource, StaticCredentialSource, loadAdsServiceKey } from './providers/reddit/credentials.js';
import { UnconfiguredProvider } from './providers/unconfigured.js';
import type { AdsStore } from './store/port.js';
import { MemoryStore } from './store/memory.js';
import { PostgresStore } from './store/postgres.js';
import type { AdsServiceConfig } from './types/config.js';

export interface RuntimeOverrides {
  audit?: AuditPublisher;
  clock?: Clock;
  auth?: ServiceAuth;
  keys?: JWTVerifyGetKey;
  logger?: Logger;
  store?: AdsStore;
  provider?: ProviderAdapter;
  pool?: pg.Pool;
}

export interface AdsRuntime {
  config: AdsServiceConfig;
  auth: ServiceAuth;
  audit: AuditPublisher;
  clock: Clock;
  logger: Logger;
  store: AdsStore;
  provider: ProviderAdapter;
  ready(): Promise<Record<string, 'ok' | 'fail'>>;
  relayOnce(): Promise<void>;
  close(): Promise<void>;
}

function createRedditProvider(reddit: Extract<AdsServiceConfig['reddit'], { enabled: true }>, production: boolean): ProviderAdapter {
  const transport = new FetchHttpTransport();
  const { apiBaseUrl, timeoutMs, userAgent, conversionPixelId, reportMaxPages } = reddit;
  const common = { apiBaseUrl, timeoutMs, userAgent, conversionPixelId, reportMaxPages };
  if (reddit.tokenSource === 'broker') {
    const key = loadAdsServiceKey(reddit.broker.privateKeyFile, production);
    return new CredentialedRedditAdapter(common, new BrokerCredentialSource(reddit.broker, key, transport), transport);
  }
  // File mode keeps the original single-account adapter path, now with attribution.
  return new CredentialedRedditAdapter(
    common,
    new StaticCredentialSource({ accessToken: reddit.accessToken, accountId: reddit.adAccountId }),
    transport
  );
}

export async function createRuntime(config: AdsServiceConfig, overrides: RuntimeOverrides = {}): Promise<AdsRuntime> {
  if (overrides.provider && config.env === 'production') {
    throw new ConfigError('provider overrides are not allowed when NODE_ENV=production');
  }
  if (overrides.store instanceof MemoryStore && config.env === 'production') {
    throw new ConfigError('MemoryStore is not allowed when NODE_ENV=production');
  }

  const clock = overrides.clock ?? new SystemClock();
  const logger = overrides.logger ?? createLogger(config.logLevel);

  let audit = overrides.audit;
  if (!audit) {
    if (config.audit.kind === 'log') {
      audit = new LogAuditPublisher(undefined, config.env);
    } else {
      audit = new RedisAuditPublisher({
        url: config.audit.redisUrl,
        clock,
        stream: config.audit.stream,
        maxStreamLength: config.audit.maxStreamLength,
      });
    }
  }

  let auth = overrides.auth;
  if (!auth) {
    const keys =
      overrides.keys ??
      (await loadPublicKeySet(config.auth.gatewayPublicKeyFile, {
        envName: 'GATEWAY_SERVICE_PUBLIC_KEY_FILE',
        nodeEnv: config.env,
      })).keys;
    auth = new ServiceTokenAuth({
      keys,
      allowedIssuers: config.auth.allowedIssuers,
      allowedSubjects: config.auth.allowedSubjects,
      now: () => clock.now(),
    });
  }

  let store = overrides.store;
  let pool: pg.Pool | undefined = overrides.pool;
  if (!store) {
    if (config.database.url) {
      pool = pool ?? new pg.Pool({
        connectionString: config.database.url,
        min: config.database.poolMin,
        max: config.database.poolMax,
      });
      await runMigrations(pool, config.database.schema);
      store = new PostgresStore(pool);
    } else if (config.env === 'test') {
      store = new MemoryStore();
    } else {
      throw new ConfigError('DATABASE_URL is required outside NODE_ENV=test');
    }
  }

  if (overrides.provider?.name === 'fake' && (config.env !== 'test' || !config.ads.allowTestFakes)) {
    throw new ConfigError('FakeProvider is test-only and requires ADS_ALLOW_TEST_FAKES');
  }
  const provider =
    overrides.provider ??
    (config.reddit.enabled ? createRedditProvider(config.reddit, config.env === 'production') : new UnconfiguredProvider());

  const relay = new OutboxRelay({
    store,
    bus: audit,
    logger,
    batchSize: config.audit.relayBatchSize,
    pollIntervalMs: config.audit.relayPollIntervalMs,
    leaseMs: config.audit.relayLeaseMs,
  });

  return {
    config,
    auth,
    audit,
    clock,
    logger,
    store,
    provider,
    async ready() {
      const checks: Record<string, 'ok' | 'fail'> = { config: 'ok' };
      try {
        await store!.ping();
        checks.postgres = 'ok';
      } catch {
        checks.postgres = 'fail';
      }
      if (config.audit.kind === 'redis' && audit?.ping) {
        try {
          await audit.ping();
          checks.audit_redis = 'ok';
        } catch {
          checks.audit_redis = 'fail';
        }
      }
      return checks;
    },
    async relayOnce() {
      await relay.runOnce();
    },
    async close() {
      await relay.stop();
      await audit?.close?.();
      await store?.close();
    },
  };
}
