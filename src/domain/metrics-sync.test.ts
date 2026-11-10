import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import type { Clock } from '../ports/clock.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../providers/http.js';
import type { MetricsFetchOutcome, MetricsFetchQuery } from '../providers/metrics.js';
import type { ProviderAdapter } from '../providers/port.js';
import { CredentialedRedditAdapter } from '../providers/reddit/brokered-adapter.js';
import { REDDIT_ADS_API_BASE } from '../providers/reddit/config.js';
import { BrokerCredentialSource } from '../providers/reddit/credentials.js';
import { ScriptedHttpTransport, type ScriptedStep } from '../providers/scripted-http.js';
import { MemoryStore } from '../store/memory.js';
import type { CampaignRecord, CampaignStatus } from '../store/port.js';
import { testConfig, FIXTURE_USER_ID, FIXTURE_WORKSPACE } from '../testing/config.js';
import {
  MetricsSyncScheduler,
  metricsSyncIdempotencyKey,
  metricsSyncWindow,
  runMetricsSyncOnce,
} from './metrics-sync.js';

const ACCOUNT = 'a2_connected';
const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const C3 = '33333333-3333-4333-8333-333333333333';
const C4 = '44444444-4444-4444-8444-444444444444';

class FixedClock implements Clock {
  constructor(public at: Date) {}
  now(): Date {
    return new Date(this.at);
  }
  isoNow(): string {
    return this.at.toISOString();
  }
}

function campaign(id: string, patch: Partial<CampaignRecord> = {}): CampaignRecord {
  return {
    workspaceId: FIXTURE_WORKSPACE,
    probaCampaignId: id,
    userId: FIXTURE_USER_ID,
    name: `c-${id.slice(0, 4)}`,
    landingPageUrl: 'https://example.test/offer',
    dailyBudget: 5,
    currency: 'GBP',
    platform: 'reddit',
    status: 'active' as CampaignStatus,
    version: 1,
    provider: 'reddit',
    providerAccountId: ACCOUNT,
    providerCampaignId: `cmp_${id.slice(0, 4)}`,
    ...patch,
  };
}

async function storeWith(...rows: CampaignRecord[]): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.withTransaction(async (tx) => {
    for (const row of rows) await tx.insertCampaign(row);
  });
  return store;
}

/** Records every query; answers with a scripted outcome (or throws). */
class StubMetricsProvider implements ProviderAdapter {
  readonly name = 'stub-metrics';
  readonly configured = true;
  readonly queries: MetricsFetchQuery[] = [];
  constructor(private readonly answer: (q: MetricsFetchQuery) => MetricsFetchOutcome | Error = () => ({
    kind: 'ok',
    observations: [],
    quarantined: [],
    pages: 1,
  })) {}
  async mutate(): Promise<never> {
    throw new Error('metrics sync must never mutate');
  }
  async connectionState() {
    return { state: 'ready' as const };
  }
  async permissionState() {
    return { state: 'ready' as const };
  }
  async billingClaim(): Promise<never> {
    throw new Error('metrics sync must never read billing');
  }
  async fetchCampaignMetrics(query: MetricsFetchQuery): Promise<MetricsFetchOutcome> {
    this.queries.push(query);
    const out = this.answer(query);
    if (out instanceof Error) throw out;
    return out;
  }
}

function syncConfig(env: NodeJS.ProcessEnv = {}) {
  const config = testConfig(env);
  return { ...config, metricsSync: { ...config.metricsSync, enabled: true } };
}

const NOW = new Date('2026-11-10T18:42:17.000Z');

describe('metrics sync window and key', () => {
  it('runs from UTC midnight lookbackDays ago to the start of the current hour', () => {
    expect(metricsSyncWindow(NOW, 2)).toEqual({
      periodStart: '2026-11-08T00:00:00.000Z',
      periodEnd: '2026-11-10T18:00:00.000Z',
    });
    expect(metricsSyncWindow(new Date('2026-11-10T00:00:00.000Z'), 1)).toEqual({
      periodStart: '2026-11-09T00:00:00.000Z',
      periodEnd: '2026-11-10T00:00:00.000Z',
    });
  });

  it('keys idempotency on campaign + window and fits the 128-char limit', () => {
    const w = metricsSyncWindow(NOW, 30);
    const key = metricsSyncIdempotencyKey(C1, w.periodStart, w.periodEnd);
    expect(key).toBe(`metrics-sync:${C1}:2026-10-11T00:00:00.000Z:2026-11-10T18:00:00.000Z`);
    expect(key.length).toBeLessThanOrEqual(128);
  });
});

describe('runMetricsSyncOnce [stub provider]', () => {
  it('fetches only mapped, active/paused Reddit campaigns, system-initiated, in their own workspace', async () => {
    const store = await storeWith(
      campaign(C1),
      campaign(C2, { status: 'paused', workspaceId: 'ws-other' }),
      campaign(C3, { status: 'draft' }),
      campaign(C4, { providerCampaignId: undefined })
    );
    const provider = new StubMetricsProvider();
    const report = await runMetricsSyncOnce({ config: syncConfig(), store, provider, clock: new FixedClock(NOW) });

    expect(report.campaigns).toBe(2);
    expect(report.counts.ingested).toBe(2);
    expect(provider.queries.map((q) => [q.workspaceId, q.probaCampaignId]).sort()).toEqual(
      [
        [FIXTURE_WORKSPACE, C1],
        ['ws-other', C2],
      ].sort()
    );
    for (const q of provider.queries) {
      expect(q.initiatedBy).toBe('system');
      expect(q.userId).toBe(FIXTURE_USER_ID);
      expect(q.granularity).toBe('day');
      expect(q.periodStart).toBe('2026-11-08T00:00:00.000Z');
      expect(q.periodEnd).toBe('2026-11-10T18:00:00.000Z');
    }
    const actions = store.outbox.map((e) => e.action);
    expect(actions.filter((a) => a === 'metrics.fetch_started')).toHaveLength(2);
    expect(actions.filter((a) => a === 'metrics.fetch_completed')).toHaveLength(2);
    const runs = store.outbox.filter((e) => e.action === 'system.job_run');
    expect(runs.map((e) => e.workspaceId).sort()).toEqual([FIXTURE_WORKSPACE, 'ws-other'].sort());
    expect(runs.every((e) => e.outcome === 'success' && e.details.job === 'ads.metrics_sync')).toBe(true);
    expect(runs.every((e) => e.details.campaignMutated === false)).toBe(true);
  });

  it('replays the same window within the hour and refetches the next hour', async () => {
    const store = await storeWith(campaign(C1));
    const provider = new StubMetricsProvider();
    const clock = new FixedClock(NOW);
    const deps = { config: syncConfig(), store, provider, clock };
    await runMetricsSyncOnce(deps);
    clock.at = new Date('2026-11-10T18:59:00.000Z');
    await runMetricsSyncOnce(deps);
    expect(provider.queries).toHaveLength(1);
    expect(store.outbox.some((e) => e.action === 'command.duplicate')).toBe(true);
    clock.at = new Date('2026-11-10T19:01:00.000Z');
    await runMetricsSyncOnce(deps);
    expect(provider.queries).toHaveLength(2);
    expect(provider.queries[1]?.periodEnd).toBe('2026-11-10T19:00:00.000Z');
  });

  it('audits a provider refusal as metrics.fetch_failed and the run as failure', async () => {
    const store = await storeWith(campaign(C1));
    const provider = new StubMetricsProvider(() => ({ kind: 'refused', code: 'provider_unauthorized', message: 'token rejected' }));
    const report = await runMetricsSyncOnce({ config: syncConfig(), store, provider, clock: new FixedClock(NOW) });
    expect(report.counts.failed).toBe(1);
    expect(report.results[0]?.code).toBe('provider_unauthorized');
    const failed = store.outbox.find((e) => e.action === 'metrics.fetch_failed');
    expect(failed?.errorCode).toBe('provider_unauthorized');
    expect(failed?.details.initiatedBy).toBe('system');
    const run = store.outbox.find((e) => e.action === 'system.job_run');
    expect(run?.outcome).toBe('failure');
    expect(run?.errorCode).toBe('metrics_sync_failures');
  });

  it('keeps going and audits when a fetch throws, without leaking the error message', async () => {
    const store = await storeWith(campaign(C1), campaign(C2));
    const provider = new StubMetricsProvider((q) =>
      q.probaCampaignId === C1 ? new Error('socket hang up token=abc123') : { kind: 'ok', observations: [], quarantined: [], pages: 1 }
    );
    const report = await runMetricsSyncOnce({ config: syncConfig(), store, provider, clock: new FixedClock(NOW) });
    expect(report.counts).toMatchObject({ error: 1, ingested: 1 });
    const failed = store.outbox.find((e) => e.action === 'metrics.fetch_failed' && e.campaignId === C1);
    expect(failed?.errorCode).toBe('metrics_sync_error');
    expect(JSON.stringify(store.outbox)).not.toContain('abc123');
    expect(store.outbox.find((e) => e.action === 'system.job_run')?.outcome).toBe('partial');
  });

  it('audits system.job_failed when the campaign list cannot be read', async () => {
    const store = await storeWith();
    store.listMetricsSyncTargets = async () => {
      throw new Error('db down');
    };
    const report = await runMetricsSyncOnce({ config: syncConfig(), store, provider: new StubMetricsProvider(), clock: new FixedClock(NOW) });
    expect(report.campaigns).toBe(0);
    const failed = store.outbox.find((e) => e.action === 'system.job_failed');
    expect(failed?.errorCode).toBe('metrics_sync_list_failed');
  });

  it('audits an empty run so the schedule is visible', async () => {
    const store = await storeWith();
    await runMetricsSyncOnce({ config: syncConfig(), store, provider: new StubMetricsProvider(), clock: new FixedClock(NOW) });
    const run = store.outbox.find((e) => e.action === 'system.job_run');
    expect(run?.outcome).toBe('success');
    expect(run?.details.campaigns).toBe(0);
  });
});

/** Fake Hub broker + scripted Reddit, routed by URL. */
class FakeBrokerAndReddit implements HttpTransport {
  readonly brokerCalls: HttpRequest[] = [];
  readonly reddit: ScriptedHttpTransport;
  constructor(private readonly broker: Array<{ status: number; body: unknown }>, steps: ScriptedStep[]) {
    this.reddit = new ScriptedHttpTransport(steps);
  }
  async request(input: HttpRequest): Promise<HttpResponse> {
    if (input.url.startsWith('http://hub.test:3000')) {
      this.brokerCalls.push(input);
      const step = this.broker.shift();
      if (!step) throw new Error('fake broker: unexpected call');
      return { status: step.status, headers: {}, bodyText: JSON.stringify(step.body) };
    }
    return this.reddit.request(input);
  }
}

describe('runMetricsSyncOnce [fake broker + scripted Reddit]', () => {
  it('asks the broker for a system-initiated metrics token and only reads reports', async () => {
    const providerCampaignId = 'cmp_live';
    const http = new FakeBrokerAndReddit(
      [
        {
          status: 200,
          body: {
            connectionId: '55555555-5555-4555-8555-555555555555',
            provider: 'reddit',
            accountId: ACCOUNT,
            accessToken: 'brokered-test-token',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            connectedBy: '66666666-6666-4666-8666-666666666666',
            scopes: ['adsread'],
          },
        },
      ],
      [
        { status: 200, body: { data: { id: providerCampaignId, ad_account_id: ACCOUNT } } },
        {
          status: 200,
          body: {
            data: {
              metrics: [
                {
                  campaign_id: providerCampaignId,
                  DATE: '2026-11-09',
                  IMPRESSIONS: 120,
                  CLICKS: 4,
                  SPEND: 1_500_000,
                  CURRENCY: 'GBP',
                  KEY_CONVERSION_TOTAL_COUNT: 1,
                },
              ],
            },
          },
        },
      ]
    );
    const { privateKey } = generateKeyPairSync('ed25519');
    const provider = new CredentialedRedditAdapter(
      { apiBaseUrl: REDDIT_ADS_API_BASE, timeoutMs: 1_000, userAgent: 'proba-ads-test' },
      new BrokerCredentialSource(
        { url: 'http://hub.test:3000', allowedHosts: ['hub.test:3000'], privateKeyFile: '/unused', keyId: 'ads-svc-1', timeoutMs: 1_000 },
        privateKey,
        http
      ),
      http
    );
    const store = await storeWith(campaign(C1, { providerCampaignId }));
    const report = await runMetricsSyncOnce({ config: syncConfig(), store, provider, clock: new FixedClock(NOW) });

    expect(report.counts.ingested).toBe(1);
    expect(http.brokerCalls).toHaveLength(1);
    const grantBody = JSON.parse(http.brokerCalls[0]!.body ?? '{}');
    expect(grantBody).toMatchObject({ workspaceId: FIXTURE_WORKSPACE, purpose: 'metrics', initiatedBy: 'system' });
    const calls = http.reddit.calls;
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(calls[1]?.url).toContain(`/ad_accounts/${ACCOUNT}/reports`);
    const ingested = store.outbox.find((e) => e.action === 'metrics.ingested');
    expect(ingested?.details).toMatchObject({ impressions: 120, clicks: 4, spend: 1.5, currency: 'GBP', accountId: ACCOUNT });
    expect(JSON.stringify(store.outbox)).not.toContain('brokered-test-token');
  });
});

describe('MetricsSyncScheduler', () => {
  it('does nothing when disabled', async () => {
    const store = await storeWith(campaign(C1));
    const provider = new StubMetricsProvider();
    const scheduler = new MetricsSyncScheduler({ config: testConfig(), store, provider, clock: new FixedClock(NOW) });
    expect(scheduler.enabled).toBe(false);
    scheduler.start();
    await scheduler.stop();
    expect(provider.queries).toHaveLength(0);
  });

  it('never overlaps runs and stops cleanly', async () => {
    const store = await storeWith(campaign(C1));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider = new StubMetricsProvider();
    const slow: ProviderAdapter = Object.assign(Object.create(provider), {
      fetchCampaignMetrics: async (q: MetricsFetchQuery) => {
        await gate;
        return provider.fetchCampaignMetrics(q);
      },
    });
    const scheduler = new MetricsSyncScheduler({ config: syncConfig(), store, provider: slow, clock: new FixedClock(NOW) });
    const first = scheduler.tick();
    expect(await scheduler.tick()).toBeUndefined();
    release();
    expect((await first)?.counts.ingested).toBe(1);
    await scheduler.stop();
    expect(await scheduler.tick()).toBeUndefined();
    expect(provider.queries).toHaveLength(1);
  });
});

describe('metrics sync config', () => {
  it('is off by default with hourly, 2-day defaults', () => {
    expect(testConfig().metricsSync).toEqual({
      enabled: false,
      intervalMs: 3_600_000,
      initialDelayMs: 60_000,
      lookbackDays: 2,
      maxCampaignsPerRun: 50,
    });
  });

  it('refuses enabling without the Reddit adapter, and out-of-range values', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', ADS_METRICS_SYNC_ENABLED: 'true' })).toThrow(/REDDIT_ADS_ENABLED/);
    expect(() => testConfig({ ADS_METRICS_SYNC_INTERVAL_SECONDS: '10' })).toThrow(/ADS_METRICS_SYNC_INTERVAL_SECONDS/);
    expect(() => testConfig({ ADS_METRICS_SYNC_LOOKBACK_DAYS: '31' })).toThrow(/ADS_METRICS_SYNC_LOOKBACK_DAYS/);
  });
});
