import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SystemClock } from '../ports/clock.js';
import { RedditAdsAdapter } from '../providers/reddit/adapter.js';
import { REDDIT_ADS_API_BASE } from '../providers/reddit/config.js';
import { ScriptedHttpTransport } from '../providers/scripted-http.js';
import { UnconfiguredProvider } from '../providers/unconfigured.js';
import { MemoryStore } from '../store/memory.js';
import { testConfig, FIXTURE_TRACE_ID, FIXTURE_USER_ID, FIXTURE_WORKSPACE } from '../testing/config.js';
import { executeMetricsFetch } from './analytics.js';

const ACCOUNT = 'a2_testaccount';
const CAMPAIGN = '11111111-1111-4111-8111-111111111111';
const PROVIDER_CAMPAIGN = 'cmp_metrics';

function caller() {
  return {
    issuer: 'proba-gateway',
    subject: 'gateway',
    jti: randomUUID(),
    keyId: 'k',
    expiresAt: new Date(Date.now() + 60_000),
  };
}

function fetchReq() {
  return {
    traceId: FIXTURE_TRACE_ID,
    workspaceId: FIXTURE_WORKSPACE,
    userId: FIXTURE_USER_ID,
    probaCampaignId: CAMPAIGN,
    periodStart: '2026-11-01T00:00:00.000Z',
    periodEnd: '2026-11-02T00:00:00.000Z',
    granularity: 'day' as const,
  };
}

async function mappedStore() {
  const store = new MemoryStore();
  await store.withTransaction(async (tx) => {
    await tx.upsertAccount({ workspaceId: FIXTURE_WORKSPACE, platform: 'reddit', accountId: ACCOUNT, status: 'ready' });
    await tx.insertCampaign({
      workspaceId: FIXTURE_WORKSPACE,
      probaCampaignId: CAMPAIGN,
      userId: FIXTURE_USER_ID,
      name: 'metrics',
      landingPageUrl: 'https://example.test/offer',
      dailyBudget: 12,
      currency: 'USD',
      platform: 'reddit',
      status: 'draft',
      version: 1,
      provider: 'reddit',
      providerAccountId: ACCOUNT,
      providerCampaignId: PROVIDER_CAMPAIGN,
      providerAdGroupId: 'grp_metrics',
    });
  });
  return store;
}

function reddit(http: ScriptedHttpTransport) {
  return new RedditAdsAdapter(
    {
      enabled: true,
      adAccountId: ACCOUNT,
      accessToken: 'test-token-not-real',
      apiBaseUrl: REDDIT_ADS_API_BASE,
      timeoutMs: 1_000,
      userAgent: 'proba-ads-test',
    },
    http
  );
}

describe('executeMetricsFetch [injected-http]', () => {
  it('emits protocol metric audit events without mutating the campaign or posting creates', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: { id: PROVIDER_CAMPAIGN, ad_account_id: ACCOUNT } } },
      {
        status: 200,
        body: {
          data: {
            metrics: [
              {
                campaign_id: PROVIDER_CAMPAIGN,
                DATE: '2026-11-01',
                IMPRESSIONS: 9,
                CLICKS: 1,
                SPEND: 2_000_000,
                CURRENCY: 'USD',
                KEY_CONVERSION_TOTAL_COUNT: 0,
              },
            ],
          },
        },
      },
    ]);
    const store = await mappedStore();
    const before = [...store.campaigns.values()][0]!;
    const result = await executeMetricsFetch(
      { config: testConfig(), store, provider: reddit(http), clock: new SystemClock() },
      fetchReq(),
      caller(),
      randomUUID()
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ingested).toBe(1);
    expect(result.data.campaignMutated).toBe(false);
    expect(result.data.observations).toHaveLength(1);
    expect(http.calls[0]?.method).toBe('GET');
    expect(http.calls[0]?.url).toContain(`/campaigns/${PROVIDER_CAMPAIGN}`);
    expect(http.calls[1]?.method).toBe('POST');
    expect(http.calls[1]?.url).toContain('/reports');
    expect(http.calls.some((call) => call.method === 'PATCH')).toBe(false);
    expect(http.calls.some((call) => call.url.includes('/campaigns') && call.method === 'POST')).toBe(false);
    expect(http.calls.some((call) => call.url.includes('funding_instruments'))).toBe(false);
    const after = [...store.campaigns.values()][0]!;
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);
    expect(after.dailyBudget).toBe(before.dailyBudget);
    expect(store.outbox.some((e) => e.action === 'metrics.ingested')).toBe(true);
    expect(store.outbox.some((e) => e.action === 'campaign.metrics_attributed')).toBe(true);
    expect(store.outbox.some((e) => e.action === 'metrics.fetch_completed')).toBe(true);
    const ingested = store.outbox.find((e) => e.action === 'metrics.ingested');
    expect(ingested?.details.impressions).toBe(9);
    expect(ingested?.details.spend).toBe(2);
  });

  it('quarantines nullable conversions and does not fabricate 0', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: { id: PROVIDER_CAMPAIGN, ad_account_id: ACCOUNT } } },
      {
        status: 200,
        body: {
          data: {
            metrics: [
              {
                campaign_id: PROVIDER_CAMPAIGN,
                DATE: '2026-11-01',
                IMPRESSIONS: 9,
                CLICKS: 1,
                SPEND: 1000,
                CURRENCY: 'USD',
              },
            ],
          },
        },
      },
    ]);
    const store = await mappedStore();
    const result = await executeMetricsFetch(
      { config: testConfig(), store, provider: reddit(http), clock: new SystemClock() },
      fetchReq(),
      caller(),
      randomUUID()
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ingested).toBe(0);
    expect(result.data.quarantined).toBe(1);
    expect(JSON.stringify(result.data.quarantinedRows)).toMatch(/conversions/);
    expect(store.outbox.some((e) => e.action === 'metrics.ingested')).toBe(false);
    expect(store.outbox.some((e) => e.action === 'metrics.fetch_completed')).toBe(true);
  });

  it('does not fetch when the provider is unconfigured and does not claim success', async () => {
    const store = await mappedStore();
    const result = await executeMetricsFetch(
      { config: testConfig(), store, provider: new UnconfiguredProvider(), clock: new SystemClock() },
      fetchReq(),
      caller(),
      randomUUID()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('provider_unconfigured');
  });

  it('refuses off-origin pagination instead of following it', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: { id: PROVIDER_CAMPAIGN, ad_account_id: ACCOUNT } } },
      {
        status: 200,
        body: {
          data: { metrics: [] },
          pagination: { next_url: 'https://evil.example/steal' },
        },
      },
    ]);
    const store = await mappedStore();
    const result = await executeMetricsFetch(
      { config: testConfig(), store, provider: reddit(http), clock: new SystemClock() },
      fetchReq(),
      caller(),
      randomUUID()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('provider_refused');
    expect(http.calls).toHaveLength(2);
    expect(store.outbox.some((e) => e.action === 'metrics.fetch_failed')).toBe(true);
  });

  it('follows same-origin next_url with GET and stops at the last page', async () => {
    const next = `${REDDIT_ADS_API_BASE}?page.token=p2`;
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: { id: PROVIDER_CAMPAIGN, ad_account_id: ACCOUNT } } },
      {
        status: 200,
        body: {
          data: {
            metrics: [
              {
                campaign_id: PROVIDER_CAMPAIGN,
                DATE: '2026-11-01',
                IMPRESSIONS: 1,
                CLICKS: 0,
                SPEND: 0,
                CURRENCY: 'USD',
                KEY_CONVERSION_TOTAL_COUNT: 0,
              },
            ],
          },
          pagination: { next_url: next },
        },
      },
      {
        status: 200,
        body: {
          data: {
            metrics: [
              {
                campaign_id: PROVIDER_CAMPAIGN,
                DATE: '2026-11-01',
                IMPRESSIONS: 2,
                CLICKS: 0,
                SPEND: 0,
                CURRENCY: 'USD',
                KEY_CONVERSION_TOTAL_COUNT: 0,
              },
            ],
          },
        },
      },
    ]);
    const store = await mappedStore();
    const result = await executeMetricsFetch(
      { config: testConfig(), store, provider: reddit(http), clock: new SystemClock() },
      fetchReq(),
      caller(),
      randomUUID()
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pages).toBe(2);
    expect(result.data.ingested).toBe(2);
    expect(http.calls[2]?.method).toBe('GET');
    expect(http.calls[2]?.url).toBe(next);
  });
});
