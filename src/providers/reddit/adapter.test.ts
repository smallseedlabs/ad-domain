import { describe, expect, it } from 'vitest';
import { ScriptedHttpTransport } from '../scripted-http.js';
import { RedditAdsAdapter } from './adapter.js';
import { REDDIT_ADS_API_BASE } from './config.js';
import type { RedditAdsConfig } from './config.js';
import type { ProviderCommand } from '../port.js';
import {
  FIXTURE_LANDING_PAGE_URL,
  FIXTURE_PROVIDER_POST_ID,
  FIXTURE_RESEARCH_ACCEPTANCE,
  FIXTURE_USER_ID,
  FIXTURE_WORKSPACE,
} from '../../testing/config.js';

const ACCOUNT = 'a2_testaccount';
const PIXEL = 't2_testpixel';

function redditConfig(overrides: Partial<RedditAdsConfig> = {}): RedditAdsConfig {
  return {
    enabled: true,
    adAccountId: ACCOUNT,
    accessToken: 'test-token-not-real',
    apiBaseUrl: REDDIT_ADS_API_BASE,
    timeoutMs: 1_000,
    userAgent: 'proba-ads-test',
    conversionPixelId: PIXEL,
    ...overrides,
  };
}

function mutationCalls(http: ScriptedHttpTransport) {
  return http.calls.filter((call) => call.method === 'POST' || call.method === 'PATCH');
}

function createCommand(overrides: Partial<ProviderCommand> = {}): ProviderCommand {
  return {
    workspaceId: FIXTURE_WORKSPACE,
    userId: FIXTURE_USER_ID,
    verb: 'ads.create_campaign',
    platform: 'reddit',
    probaCampaignId: '11111111-1111-4111-8111-111111111111',
    landingPageUrl: FIXTURE_LANDING_PAGE_URL,
    providerAccountId: ACCOUNT,
    args: {
      verb: 'ads.create_campaign',
      name: 'probe',
      landingPageUrl: FIXTURE_LANDING_PAGE_URL,
      dailyBudget: 12,
      currency: 'USD',
      platform: 'reddit',
      providerAccountId: ACCOUNT,
      providerPostId: FIXTURE_PROVIDER_POST_ID,
      researchAcceptance: { ...FIXTURE_RESEARCH_ACCEPTANCE },
    },
    ...overrides,
  };
}

describe('RedditAdsAdapter [injected-http]', () => {
  it('does not treat missing funding instruments as a verified zero', async () => {
    const http = new ScriptedHttpTransport([{ status: 404, body: { error: { message: 'not found' } } }]);
    const adapter = new RedditAdsAdapter(redditConfig(), http);
    const claim = await adapter.billingClaim(FIXTURE_WORKSPACE, 'reddit');
    expect(claim.kind).toBe('unknown');
    if (claim.kind === 'unknown') expect(claim.reason.toLowerCase()).toContain('not a verified zero');
  });

  it('treats a timeout on funding instruments as unknown billing, not eligible', async () => {
    const http = new ScriptedHttpTransport([{ timeout: true }]);
    const adapter = new RedditAdsAdapter(redditConfig(), http);
    const claim = await adapter.billingClaim(FIXTURE_WORKSPACE, 'reddit');
    expect(claim.kind).toBe('unknown');
  });

  it('rate-limits billing as unknown (fail closed) and does not retry', async () => {
    const http = new ScriptedHttpTransport([{ status: 429, body: { error: { code: 429, message: 'Too Many Requests' } } }]);
    const adapter = new RedditAdsAdapter(redditConfig(), http);
    const claim = await adapter.billingClaim(FIXTURE_WORKSPACE, 'reddit');
    expect(claim.kind).toBe('unknown');
    expect(http.calls).toHaveLength(1);
  });

  it('reports verified ineligible when instruments exist but none are servable', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: false, currency: 'USD' }] } },
    ]);
    const adapter = new RedditAdsAdapter(redditConfig(), http);
    const claim = await adapter.billingClaim(FIXTURE_WORKSPACE, 'reddit');
    expect(claim).toMatchObject({ kind: 'verified', eligible: false, mode: 'billing_eligibility' });
  });

  it('creates campaign, ad group, and ad with the exact user landing URL as click_url', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: { id: FIXTURE_PROVIDER_POST_ID } } },
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
      { status: 201, body: { data: { id: 'cmp_1', ad_account_id: ACCOUNT } } },
      { status: 201, body: { data: { id: 'grp_1' } } },
      { status: 201, body: { data: { id: 'ad_1', click_url: FIXTURE_LANDING_PAGE_URL } } },
    ]);
    const adapter = new RedditAdsAdapter(redditConfig(), http);
    const result = await adapter.mutate(createCommand());
    expect(result).toEqual({
      kind: 'success',
      mapping: {
        provider: 'reddit',
        providerCampaignId: 'cmp_1',
        providerAdGroupId: 'grp_1',
        providerAdId: 'ad_1',
        providerAccountId: ACCOUNT,
        launchKind: 'deliverable_ad',
        deliverableAd: true,
        clickUrlPushed: true,
      },
    });
    expect(http.calls[0]!.url).toContain(`/structured_posts/${FIXTURE_PROVIDER_POST_ID}`);
    const createBody = JSON.parse(http.calls[2]!.body ?? '{}') as { data: { objective: string; name: string } };
    expect(createBody.data.objective).toBe('CLICKS');
    const groupBody = JSON.parse(http.calls[3]!.body ?? '{}') as {
      data: { goal_type: string; bid_type: string; conversion_pixel_id?: string };
    };
    expect(groupBody.data.goal_type).toBe('DAILY_SPEND');
    expect(groupBody.data.bid_type).toBe('CPC');
    expect(groupBody.data.conversion_pixel_id).toBe(PIXEL);
    const adBody = JSON.parse(http.calls[4]!.body ?? '{}') as {
      data: { click_url: string; post_id: string; ad_group_id: string };
    };
    expect(adBody.data.click_url).toBe(FIXTURE_LANDING_PAGE_URL);
    expect(adBody.data.post_id).toBe(FIXTURE_PROVIDER_POST_ID);
    expect(adBody.data.ad_group_id).toBe('grp_1');
    expect(JSON.stringify(http.calls)).not.toContain('smallseedlabs.com');
    expect(http.calls[0]!.headers.authorization).toBe('Bearer test-token-not-real');
  });

  it('refuses create before any remote mutation when providerPostId is missing', async () => {
    const http = new ScriptedHttpTransport([]);
    const adapter = new RedditAdsAdapter(redditConfig(), http);
    const result = await adapter.mutate(
      createCommand({
        args: {
          verb: 'ads.create_campaign',
          name: 'probe',
          landingPageUrl: FIXTURE_LANDING_PAGE_URL,
          dailyBudget: 12,
          currency: 'USD',
          platform: 'reddit',
          providerAccountId: ACCOUNT,
          researchAcceptance: { ...FIXTURE_RESEARCH_ACCEPTANCE },
        },
      })
    );
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.code).toBe('provider_prerequisites_missing');
    expect(http.calls).toHaveLength(0);
  });

  it('refuses create before any remote mutation when conversion_pixel_id is missing', async () => {
    const http = new ScriptedHttpTransport([{ status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } }]);
    const adapter = new RedditAdsAdapter(redditConfig({ conversionPixelId: undefined }), http);
    const result = await adapter.mutate(createCommand());
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.code).toBe('provider_prerequisites_missing');
    expect(mutationCalls(http)).toHaveLength(0);
    expect(http.calls).toHaveLength(0);
  });

  it('refuses create before any remote mutation when conversion_pixel_id is invalid', async () => {
    const http = new ScriptedHttpTransport([]);
    const adapter = new RedditAdsAdapter(redditConfig({ conversionPixelId: 'not a pixel' }), http);
    const result = await adapter.mutate(createCommand());
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.code).toBe('provider_prerequisites_missing');
    expect(http.calls).toHaveLength(0);
  });

  it('refuses a mapped account that is not the configured Reddit account', async () => {
    const http = new ScriptedHttpTransport([]);
    const adapter = new RedditAdsAdapter(redditConfig(), http);
    const result = await adapter.mutate(createCommand({ providerAccountId: 'a2_other' }));
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.code).toBe('ownership_mismatch');
    expect(http.calls).toHaveLength(0);
  });

  it('refuses pause when the remote campaign belongs to another ad account', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: { id: 'cmp_1', ad_account_id: 'a2_other' } } },
    ]);
    const adapter = new RedditAdsAdapter(redditConfig(), http);
    const result = await adapter.mutate(
      createCommand({
        verb: 'ads.pause_campaign',
        providerCampaignId: 'cmp_1',
        args: { verb: 'ads.pause_campaign', probaCampaignId: '11111111-1111-4111-8111-111111111111' },
      })
    );
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.code).toBe('ownership_mismatch');
  });

  it('marks a timed-out create as ambiguous and does not retry', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: { id: FIXTURE_PROVIDER_POST_ID } } },
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
      { timeout: true },
    ]);
    const adapter = new RedditAdsAdapter(redditConfig(), http);
    const result = await adapter.mutate(createCommand());
    expect(result.kind).toBe('ambiguous');
    expect(http.calls).toHaveLength(3);
  });

  it('refuses create before campaign POST when the structured post is missing', async () => {
    const http = new ScriptedHttpTransport([{ status: 404, body: { error: { message: 'post not found' } } }]);
    const adapter = new RedditAdsAdapter(redditConfig(), http);
    const result = await adapter.mutate(createCommand());
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.code).toBe('provider_prerequisites_missing');
    expect(mutationCalls(http)).toHaveLength(0);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.method).toBe('GET');
  });

  it('marks a timed-out ad create as ambiguous after campaign and ad group exist', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: { id: FIXTURE_PROVIDER_POST_ID } } },
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
      { status: 201, body: { data: { id: 'cmp_1', ad_account_id: ACCOUNT } } },
      { status: 201, body: { data: { id: 'grp_1' } } },
      { timeout: true },
    ]);
    const adapter = new RedditAdsAdapter(redditConfig(), http);
    const result = await adapter.mutate(createCommand());
    expect(result.kind).toBe('ambiguous');
    expect(mutationCalls(http)).toHaveLength(3);
  });

  it('does not claim a launch when ad create is refused after campaign and ad group exist', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: { id: FIXTURE_PROVIDER_POST_ID } } },
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
      { status: 201, body: { data: { id: 'cmp_1', ad_account_id: ACCOUNT } } },
      { status: 201, body: { data: { id: 'grp_1' } } },
      { status: 400, body: { error: { message: 'invalid ad' } } },
    ]);
    const adapter = new RedditAdsAdapter(redditConfig(), http);
    const result = await adapter.mutate(createCommand());
    expect(result).toEqual({
      kind: 'success',
      mapping: {
        provider: 'reddit',
        providerCampaignId: 'cmp_1',
        providerAdGroupId: 'grp_1',
        providerAccountId: ACCOUNT,
        launchKind: 'campaign_ad_group_scaffold',
        deliverableAd: false,
        clickUrlPushed: false,
        missingEntities: ['ad', 'click_url'],
      },
    });
  });

  it('refuses landingPageUrl update when no providerAdId mapping exists', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: { id: 'cmp_1', ad_account_id: ACCOUNT } } },
    ]);
    const adapter = new RedditAdsAdapter(redditConfig(), http);
    const result = await adapter.mutate(
      createCommand({
        verb: 'ads.update_campaign',
        providerCampaignId: 'cmp_1',
        providerAdGroupId: 'grp_1',
        args: {
          verb: 'ads.update_campaign',
          probaCampaignId: '11111111-1111-4111-8111-111111111111',
          landingPageUrl: FIXTURE_LANDING_PAGE_URL,
        },
      })
    );
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.code).toBe('provider_prerequisites_missing');
    expect(mutationCalls(http)).toHaveLength(0);
  });

  it('treats a paginated funding list with no servable instrument as unknown, not a verified zero', async () => {
    const http = new ScriptedHttpTransport([
      {
        status: 200,
        body: {
          data: [{ id: 'fi_1', is_servable: false, currency: 'USD' }],
          pagination: { next_url: 'https://ads-api.reddit.com/api/v3/ad_accounts/a2_testaccount/funding_instruments?page.token=more' },
        },
      },
    ]);
    const adapter = new RedditAdsAdapter(redditConfig(), http);
    const claim = await adapter.billingClaim(FIXTURE_WORKSPACE, 'reddit');
    expect(claim.kind).toBe('unknown');
  });

  it('pauses the mapped campaign without querying funding instruments', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: { id: 'cmp_1', ad_account_id: ACCOUNT } } },
      { status: 200, body: { data: { id: 'cmp_1', configured_status: 'PAUSED', ad_account_id: ACCOUNT } } },
    ]);
    const adapter = new RedditAdsAdapter(redditConfig(), http);
    const result = await adapter.mutate(
      createCommand({
        verb: 'ads.pause_campaign',
        providerCampaignId: 'cmp_1',
        args: { verb: 'ads.pause_campaign', probaCampaignId: '11111111-1111-4111-8111-111111111111' },
      })
    );
    expect(result.kind).toBe('success');
    expect(http.calls).toHaveLength(2);
    expect(http.calls.every((call) => !call.url.includes('funding_instruments'))).toBe(true);
  });

  it('does not blindly retry a 429 on mutate', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { data: { id: FIXTURE_PROVIDER_POST_ID } } },
      { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
      { status: 429, headers: { ratelimit: 'ads-campaign-management-write;r=0;t=60' }, body: { error: { code: 429 } } },
    ]);
    const adapter = new RedditAdsAdapter(redditConfig(), http);
    const result = await adapter.mutate(createCommand());
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.code).toBe('provider_rate_limited');
    expect(http.calls).toHaveLength(3);
  });
});
