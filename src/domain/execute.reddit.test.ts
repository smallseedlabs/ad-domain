import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AmbiguousOutcomeError } from '../errors.js';
import { SystemClock } from '../ports/clock.js';
import { RedditAdsAdapter } from '../providers/reddit/adapter.js';
import { REDDIT_ADS_API_BASE } from '../providers/reddit/config.js';
import { ScriptedHttpTransport } from '../providers/scripted-http.js';
import { MemoryStore } from '../store/memory.js';
import { testConfig, FIXTURE_LANDING_PAGE_URL, FIXTURE_TRACE_ID, FIXTURE_USER_ID, FIXTURE_WORKSPACE } from '../testing/config.js';
import { executeCampaignAction } from './execute.js';

const ACCOUNT = 'a2_testaccount';
const PIXEL = 't2_testpixel';

function caller() {
  return {
    issuer: 'proba-gateway',
    subject: 'gateway',
    jti: randomUUID(),
    keyId: 'k',
    expiresAt: new Date(Date.now() + 60_000),
  };
}

function createReq() {
  return {
    traceId: FIXTURE_TRACE_ID,
    workspaceId: FIXTURE_WORKSPACE,
    userId: FIXTURE_USER_ID,
    verb: 'ads.create_campaign' as const,
    args: {
      name: 'reddit-execute',
      landingPageUrl: FIXTURE_LANDING_PAGE_URL,
      dailyBudget: 12,
      currency: 'USD',
      platform: 'reddit' as const,
      providerAccountId: ACCOUNT,
    },
  };
}

describe('executeCampaignAction [reddit-injected-http]', () => {
  it('persists Reddit mappings and the supplied landing URL on success', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
      { status: 201, body: { data: { id: 'cmp_exec', ad_account_id: ACCOUNT } } },
      { status: 201, body: { data: { id: 'grp_exec' } } },
    ]);
    const store = new MemoryStore();
    await store.withTransaction((tx) =>
      tx.upsertAccount({ workspaceId: FIXTURE_WORKSPACE, platform: 'reddit', accountId: ACCOUNT, status: 'ready' })
    );
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
    const result = await executeCampaignAction(
      { config: testConfig(), store, provider, clock: new SystemClock() },
      createReq(),
      caller(),
      randomUUID()
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.landingPageUrl).toBe(FIXTURE_LANDING_PAGE_URL);
    expect(result.data.providerLaunch).toBe('campaign_ad_group_scaffold');
    expect(result.data.deliverableAd).toBe(false);
    expect(result.data.clickUrlPushed).toBe(false);
    expect(result.data.mappings?.[0]).toMatchObject({
      provider: 'reddit',
      providerCampaignId: 'cmp_exec',
      providerAdGroupId: 'grp_exec',
    });
  });

  it('refuses create without posting when conversion pixel is missing [zero-mutation]', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
    ]);
    const store = new MemoryStore();
    await store.withTransaction((tx) =>
      tx.upsertAccount({ workspaceId: FIXTURE_WORKSPACE, platform: 'reddit', accountId: ACCOUNT, status: 'ready' })
    );
    const provider = new RedditAdsAdapter(
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
    const result = await executeCampaignAction(
      { config: testConfig(), store, provider, clock: new SystemClock() },
      createReq(),
      caller(),
      randomUUID()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('provider_prerequisites_missing');
    expect(http.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(http.calls.some((call) => call.method === 'POST' || call.method === 'PATCH')).toBe(false);
    for (const campaign of store.campaigns.values()) {
      expect(campaign.providerCampaignId).toBeUndefined();
    }
  });

  it('persists ambiguous outcome on provider timeout and refuses replay', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
      { timeout: true },
    ]);
    const store = new MemoryStore();
    await store.withTransaction((tx) =>
      tx.upsertAccount({ workspaceId: FIXTURE_WORKSPACE, platform: 'reddit', accountId: ACCOUNT, status: 'ready' })
    );
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
    const key = randomUUID();
    const deps = { config: testConfig(), store, provider, clock: new SystemClock() };
    await expect(executeCampaignAction(deps, createReq(), caller(), key)).rejects.toBeInstanceOf(AmbiguousOutcomeError);
    await expect(executeCampaignAction(deps, createReq(), caller(), key)).rejects.toBeInstanceOf(AmbiguousOutcomeError);
    expect(http.calls.length).toBe(3);
  });

  it('refuses create when billing is unknown because funding instruments 5xx', async () => {
    const http = new ScriptedHttpTransport([{ status: 503, body: { error: { message: 'unavailable' } } }]);
    const store = new MemoryStore();
    await store.withTransaction((tx) =>
      tx.upsertAccount({ workspaceId: FIXTURE_WORKSPACE, platform: 'reddit', accountId: ACCOUNT, status: 'ready' })
    );
    const provider = new RedditAdsAdapter(
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
    const result = await executeCampaignAction(
      { config: testConfig(), store, provider, clock: new SystemClock() },
      createReq(),
      caller(),
      randomUUID()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('billing_not_ready');
    expect(store.campaigns.size).toBe(0);
  });
});
