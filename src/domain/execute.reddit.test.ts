import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AmbiguousOutcomeError } from '../errors.js';
import { SystemClock } from '../ports/clock.js';
import { RedditAdsAdapter } from '../providers/reddit/adapter.js';
import { REDDIT_ADS_API_BASE } from '../providers/reddit/config.js';
import { ScriptedHttpTransport } from '../providers/scripted-http.js';
import { MemoryStore } from '../store/memory.js';
import {
  testConfig,
  fixtureCreateArgs,
  FIXTURE_GOAL_ID,
  FIXTURE_LANDING_PAGE_URL,
  FIXTURE_PROVIDER_POST_ID,
  FIXTURE_PROVIDER_PROFILE_ID,
  FIXTURE_TRACE_ID,
  FIXTURE_USER_ID,
  FIXTURE_WORKSPACE,
} from '../testing/config.js';
import { ClosedResearchAcceptanceGate } from './research-acceptance.js';
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
    goalId: FIXTURE_GOAL_ID,
    verb: 'ads.create_campaign' as const,
    args: fixtureCreateArgs({
      name: 'reddit-execute',
      providerAccountId: ACCOUNT,
    }),
  };
}

describe('executeCampaignAction [reddit-injected-http]', () => {
  it('persists Reddit mappings and the supplied landing URL on success', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
      { status: 200, body: { data: [{ id: FIXTURE_PROVIDER_PROFILE_ID }], pagination: {} } },
      {
        status: 201,
        body: { data: { id: 'job_1', status: 'QUEUED', created_at: '2026-11-08T00:00:00Z', modified_at: '2026-11-08T00:00:00Z' } },
      },
      {
        status: 200,
        body: {
          data: {
            id: 'job_1',
            status: 'SUCCESS',
            post_id: FIXTURE_PROVIDER_POST_ID,
            error_message: null,
            created_at: '2026-11-08T00:00:00Z',
            modified_at: '2026-11-08T00:00:01Z',
          },
        },
      },
      { status: 200, body: { data: { id: FIXTURE_PROVIDER_POST_ID } } },
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
      { status: 201, body: { data: { id: 'cmp_exec', ad_account_id: ACCOUNT } } },
      { status: 201, body: { data: { id: 'grp_exec' } } },
      { status: 201, body: { data: { id: 'ad_exec', click_url: FIXTURE_LANDING_PAGE_URL } } },
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
    expect(result.data.providerLaunch).toBe('deliverable_ad');
    expect(result.data.deliverableAd).toBe(true);
    expect(result.data.clickUrlPushed).toBe(true);
    expect(result.data.mappings?.[0]).toMatchObject({
      provider: 'reddit',
      providerCampaignId: 'cmp_exec',
      providerAdGroupId: 'grp_exec',
      providerAdId: 'ad_exec',
    });
    const adCall = http.calls.find((call) => call.method === 'POST' && /\/ads(?:\?|$)/.test(call.url));
    expect(adCall).toBeDefined();
    expect(JSON.parse(adCall!.body ?? '{}').data.click_url).toBe(FIXTURE_LANDING_PAGE_URL);
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

  it('refuses create before billing when research acceptance is unverified [closed gate]', async () => {
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
        conversionPixelId: PIXEL,
      },
      http
    );
    const result = await executeCampaignAction(
      {
        config: testConfig({ ADS_ALLOW_TEST_FAKES: 'false' }),
        store,
        provider,
        clock: new SystemClock(),
        researchAcceptance: new ClosedResearchAcceptanceGate(),
      },
      createReq(),
      caller(),
      randomUUID()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('research_acceptance_unverified');
    expect(http.calls).toHaveLength(0);
    expect(store.campaigns.size).toBe(0);
  });

  it('persists ambiguous outcome on provider timeout and refuses replay', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
      { status: 200, body: { data: { id: FIXTURE_PROVIDER_POST_ID } } },
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
    const timeoutReq = {
      ...createReq(),
      args: fixtureCreateArgs({
        name: 'reddit-execute',
        providerAccountId: ACCOUNT,
        providerPostId: FIXTURE_PROVIDER_POST_ID,
      }),
    };
    await expect(executeCampaignAction(deps, timeoutReq, caller(), key)).rejects.toBeInstanceOf(AmbiguousOutcomeError);
    await expect(executeCampaignAction(deps, timeoutReq, caller(), key)).rejects.toBeInstanceOf(AmbiguousOutcomeError);
    expect(http.calls.length).toBe(4);
    expect(http.calls.some((call) => call.method === 'POST' && call.url.includes('/campaigns'))).toBe(true);
  });

  it('refuses create with no campaign POST when the structured post is missing', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
      { status: 404, body: { error: { message: 'post not found' } } },
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
      {
        ...createReq(),
        args: fixtureCreateArgs({
          name: 'reddit-execute',
          providerAccountId: ACCOUNT,
          providerPostId: FIXTURE_PROVIDER_POST_ID,
        }),
      },
      caller(),
      randomUUID()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('provider_prerequisites_missing');
    expect(http.calls.some((call) => call.method === 'POST')).toBe(false);
    for (const campaign of store.campaigns.values()) {
      expect(campaign.providerCampaignId).toBeUndefined();
      expect(campaign.status).toBe('draft');
    }
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
