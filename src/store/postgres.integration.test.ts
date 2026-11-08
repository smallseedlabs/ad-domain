import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../ports/clock.js';
import { FakeProvider, eligibleBillingClaim } from '../providers/fake.js';
import { UnconfiguredProvider } from '../providers/unconfigured.js';
import { executeCampaignAction } from '../domain/execute.js';
import { runMigrations } from '../db/migrate.js';
import { PostgresStore } from './postgres.js';
import { OutboxRelay } from '../audit/relay.js';
import { MemoryAuditPublisher } from '../audit/publisher.js';
import { createLogger } from '../logger.js';
import { testConfig, FIXTURE_LANDING_PAGE_URL, FIXTURE_TRACE_ID, FIXTURE_USER_ID } from '../testing/config.js';
import { realPostgresUrl } from '../testing/real-env.js';

describe.skipIf(!realPostgresUrl())('Postgres store + outbox [real-pg]', () => {
  const url = realPostgresUrl()!;
  let pool: pg.Pool;
  let store: PostgresStore;
  const workspace = `ws-${randomUUID()}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool, 'ads');
    store = new PostgresStore(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('survives process-style reopen and does not claim success without a provider', async () => {
    const result = await executeCampaignAction(
      { config: testConfig(), store, provider: new UnconfiguredProvider(), clock: new SystemClock() },
      {
        traceId: FIXTURE_TRACE_ID,
        workspaceId: workspace,
        userId: FIXTURE_USER_ID,
        verb: 'ads.create_campaign',
        args: {
          name: 'pg',
          landingPageUrl: FIXTURE_LANDING_PAGE_URL,
          dailyBudget: 12,
          currency: 'USD',
          platform: 'reddit',
        },
      },
      {
        issuer: 'proba-gateway',
        subject: 'gateway',
        jti: randomUUID(),
        keyId: 'k',
        expiresAt: new Date(Date.now() + 60_000),
      },
      randomUUID()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('provider_unconfigured');

    const reopened = new PostgresStore(pool);
    const ping = reopened.ping();
    await expect(ping).resolves.toBeUndefined();
  });

  it('writes audit rows transactionally and relays them without executing commands [real-pg]', async () => {
    const fake = new FakeProvider();
    fake.billing = eligibleBillingClaim();
    await store.withTransaction((tx) =>
      tx.upsertAccount({ workspaceId: workspace, platform: 'reddit', accountId: fake.accountId, status: 'ready' })
    );
    const created = await executeCampaignAction(
      { config: testConfig(), store, provider: fake, clock: new SystemClock() },
      {
        traceId: FIXTURE_TRACE_ID,
        workspaceId: workspace,
        userId: FIXTURE_USER_ID,
        verb: 'ads.create_campaign',
        args: {
          name: 'pg-ok',
          landingPageUrl: FIXTURE_LANDING_PAGE_URL,
          dailyBudget: 12,
          currency: 'USD',
          platform: 'reddit',
        },
      },
      {
        issuer: 'proba-gateway',
        subject: 'gateway',
        jti: randomUUID(),
        keyId: 'k',
        expiresAt: new Date(Date.now() + 60_000),
      },
      randomUUID()
    );
    expect(created.ok).toBe(true);

    const bus = new MemoryAuditPublisher();
    const relay = new OutboxRelay({
      store,
      bus,
      logger: createLogger('silent'),
      batchSize: 50,
      pollIntervalMs: 50,
      leaseMs: 5_000,
    });
    const cycle = await relay.runOnce();
    expect(cycle.published).toBeGreaterThan(0);
    expect(bus.events.some((e) => e.action === 'campaign.created')).toBe(true);
    expect(bus.events.every((e) => e.action !== 'command.processed' || e.outcome === 'success')).toBe(true);
  });
});
