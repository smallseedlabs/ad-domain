import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AmbiguousOutcomeError } from '../../errors.js';
import { SystemClock } from '../../ports/clock.js';
import { executeMetricsFetch } from '../../domain/analytics.js';
import { executeCampaignAction } from '../../domain/execute.js';
import { runMigrations } from '../../db/migrate.js';
import { PostgresStore } from '../../store/postgres.js';
import { OutboxRelay } from '../../audit/relay.js';
import { MemoryAuditPublisher } from '../../audit/publisher.js';
import { createLogger } from '../../logger.js';
import {
  testConfig,
  fixtureCreateArgs,
  FIXTURE_GOAL_ID,
  FIXTURE_LANDING_PAGE_URL,
  FIXTURE_PROVIDER_POST_ID,
  FIXTURE_TRACE_ID,
  FIXTURE_USER_ID,
} from '../../testing/config.js';
import { realPostgresUrl } from '../../testing/real-env.js';
import { RedditAdsAdapter } from './adapter.js';
import { REDDIT_ADS_API_BASE } from './config.js';
import { ScriptedHttpTransport } from '../scripted-http.js';

const ACCOUNT = 'a2_pg_reddit';
const PIXEL = 't2_testpixel';

describe.skipIf(!realPostgresUrl())('Reddit adapter + Postgres [real-pg] [injected-http]', () => {
  const url = realPostgresUrl()!;
  let pool: pg.Pool;
  let store: PostgresStore;
  const workspace = `ws-reddit-${randomUUID()}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool, 'ads');
    store = new PostgresStore(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('persists mapping, outbox, and does not claim success on duplicate in-flight timeout [real-pg]', async () => {
    await store.withTransaction((tx) =>
      tx.upsertAccount({ workspaceId: workspace, platform: 'reddit', accountId: ACCOUNT, status: 'ready' })
    );
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
      { status: 200, body: { data: { id: FIXTURE_PROVIDER_POST_ID } } },
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
      { status: 201, body: { data: { id: 'cmp_pg', ad_account_id: ACCOUNT } } },
      { status: 201, body: { data: { id: 'grp_pg' } } },
      { status: 201, body: { data: { id: 'ad_pg', click_url: FIXTURE_LANDING_PAGE_URL } } },
    ]);
    const provider = new RedditAdsAdapter(
      {
        enabled: true,
        adAccountId: ACCOUNT,
        accessToken: 'test-token-not-real',
        apiBaseUrl: REDDIT_ADS_API_BASE,
        timeoutMs: 1_000,
        userAgent: 'proba-ads-test',
        conversionPixelId: PIXEL,
      },
      http
    );
    const created = await executeCampaignAction(
      { config: testConfig(), store, provider, clock: new SystemClock() },
      {
        traceId: FIXTURE_TRACE_ID,
        workspaceId: workspace,
        userId: FIXTURE_USER_ID,
        verb: 'ads.create_campaign',
        goalId: FIXTURE_GOAL_ID,
        args: fixtureCreateArgs({
          name: 'pg-reddit',
          providerAccountId: ACCOUNT,
        }),
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
    if (!created.ok) return;
    expect(created.data.landingPageUrl).toBe(FIXTURE_LANDING_PAGE_URL);
    expect(created.data.providerLaunch).toBe('deliverable_ad');
    expect(created.data.deliverableAd).toBe(true);
    expect(created.data.clickUrlPushed).toBe(true);
    expect(created.data.mappings?.[0]?.providerCampaignId).toBe('cmp_pg');
    expect(created.data.mappings?.[0]?.providerAdId).toBe('ad_pg');

    const bus = new MemoryAuditPublisher();
    const relay = new OutboxRelay({
      store,
      bus,
      logger: createLogger('silent'),
      batchSize: 50,
      pollIntervalMs: 50,
      leaseMs: 5_000,
    });
    let foundCreated = false;
    for (let i = 0; i < 20; i++) {
      const cycle = await relay.runOnce();
      foundCreated = bus.events.some(
        (e) => e.action === 'campaign.launched' && e.campaignId === created.data.probaCampaignId
      );
      if (foundCreated || cycle.claimed === 0) break;
    }
    expect(foundCreated).toBe(true);

    const timeoutHttp = new ScriptedHttpTransport([
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
      { status: 200, body: { data: { id: FIXTURE_PROVIDER_POST_ID } } },
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
      { timeout: true },
    ]);
    const timeoutProvider = new RedditAdsAdapter(
      {
        enabled: true,
        adAccountId: ACCOUNT,
        accessToken: 'test-token-not-real',
        apiBaseUrl: REDDIT_ADS_API_BASE,
        timeoutMs: 1_000,
        userAgent: 'proba-ads-test',
        conversionPixelId: PIXEL,
      },
      timeoutHttp
    );
    const key = randomUUID();
    await expect(
      executeCampaignAction(
        { config: testConfig(), store, provider: timeoutProvider, clock: new SystemClock() },
        {
          traceId: FIXTURE_TRACE_ID,
          workspaceId: workspace,
          userId: FIXTURE_USER_ID,
          verb: 'ads.create_campaign',
          goalId: FIXTURE_GOAL_ID,
          args: fixtureCreateArgs({
            name: 'pg-timeout',
            dailyBudget: 8,
            providerAccountId: ACCOUNT,
          }),
        },
        {
          issuer: 'proba-gateway',
          subject: 'gateway',
          jti: randomUUID(),
          keyId: 'k',
          expiresAt: new Date(Date.now() + 60_000),
        },
        key
      )
    ).rejects.toBeInstanceOf(AmbiguousOutcomeError);

    const reopened = new PostgresStore(pool);
    await expect(
      executeCampaignAction(
        { config: testConfig(), store: reopened, provider: timeoutProvider, clock: new SystemClock() },
        {
          traceId: FIXTURE_TRACE_ID,
          workspaceId: workspace,
          userId: FIXTURE_USER_ID,
          verb: 'ads.create_campaign',
          goalId: FIXTURE_GOAL_ID,
          args: fixtureCreateArgs({
            name: 'pg-timeout',
            dailyBudget: 8,
            providerAccountId: ACCOUNT,
          }),
        },
        {
          issuer: 'proba-gateway',
          subject: 'gateway',
          jti: randomUUID(),
          keyId: 'k',
          expiresAt: new Date(Date.now() + 60_000),
        },
        key
      )
    ).rejects.toBeInstanceOf(AmbiguousOutcomeError);
  });

  it('writes metrics.ingested to the outbox without changing campaign rows [real-pg]', async () => {
    const ws = `ws-metrics-${randomUUID()}`;
    const probaCampaignId = randomUUID();
    await store.withTransaction(async (tx) => {
      await tx.upsertAccount({ workspaceId: ws, platform: 'reddit', accountId: ACCOUNT, status: 'ready' });
      await tx.insertCampaign({
        workspaceId: ws,
        probaCampaignId,
        userId: FIXTURE_USER_ID,
        name: 'metrics-pg',
        landingPageUrl: FIXTURE_LANDING_PAGE_URL,
        dailyBudget: 12,
        currency: 'USD',
        platform: 'reddit',
        status: 'draft',
        version: 1,
        provider: 'reddit',
        providerAccountId: ACCOUNT,
        providerCampaignId: 'cmp_metrics_pg',
      });
    });
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: { id: 'cmp_metrics_pg', ad_account_id: ACCOUNT } } },
      {
        status: 200,
        body: {
          data: {
            metrics: [
              {
                campaign_id: 'cmp_metrics_pg',
                DATE: '2026-11-01',
                IMPRESSIONS: 4,
                CLICKS: 1,
                SPEND: 1_000_000,
                CURRENCY: 'USD',
                KEY_CONVERSION_TOTAL_COUNT: 0,
              },
            ],
          },
        },
      },
    ]);
    const provider = new RedditAdsAdapter(
      {
        enabled: true,
        adAccountId: ACCOUNT,
        accessToken: 'test-token-not-real',
        apiBaseUrl: REDDIT_ADS_API_BASE,
        timeoutMs: 1_000,
        userAgent: 'proba-ads-test',
        conversionPixelId: PIXEL,
      },
      http
    );
    const fetched = await executeMetricsFetch(
      { config: testConfig(), store, provider, clock: new SystemClock() },
      {
        traceId: FIXTURE_TRACE_ID,
        workspaceId: ws,
        userId: FIXTURE_USER_ID,
        probaCampaignId,
        periodStart: '2026-11-01T00:00:00.000Z',
        periodEnd: '2026-11-02T00:00:00.000Z',
        granularity: 'day',
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
    expect(fetched.ok).toBe(true);
    const locked = await store.withTransaction((tx) => tx.getCampaign(ws, probaCampaignId));
    expect(locked?.status).toBe('draft');
    expect(locked?.version).toBe(1);
    expect(http.calls.every((call) => call.method !== 'PATCH')).toBe(true);

    const bus = new MemoryAuditPublisher();
    const relay = new OutboxRelay({
      store,
      bus,
      logger: createLogger('silent'),
      batchSize: 50,
      pollIntervalMs: 50,
      leaseMs: 5_000,
    });
    let found = false;
    for (let i = 0; i < 20; i++) {
      await relay.runOnce();
      found = bus.events.some((e) => e.action === 'metrics.ingested' && e.campaignId === probaCampaignId);
      if (found) break;
    }
    expect(found).toBe(true);
  });
});
