import { describe, expect, it } from 'vitest';
import { ScriptedHttpTransport } from '../scripted-http.js';
import type { ProviderCommand } from '../port.js';
import { MetaAdsAdapter } from './adapter.js';

function createCommand(overrides: Partial<ProviderCommand> = {}): ProviderCommand {
  return {
    workspaceId: 'ws_1',
    userId: 'u_1',
    verb: 'ads.create_campaign',
    platform: 'meta',
    probaCampaignId: 'pc_meta_1',
    args: {
      verb: 'ads.create_campaign',
      name: 'Proba Meta Launch',
      landingPageUrl: 'https://smallseedlabs.co.uk/',
      dailyBudget: 15,
      currency: 'USD',
      platform: 'meta',
      creative: {
        type: 'IMAGE',
        headline: 'Automate your growth',
        body: 'AI-native ad operations.',
        mediaUrl: 'https://smallseedlabs.co.uk/hero.png',
      },
    },
    ...overrides,
  };
}

describe('MetaAdsAdapter', () => {
  it('uploads image creative and launches campaign -> adset -> adcreative -> ad', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { id: 'act_123', account_status: 1 } },
      { status: 200, body: { data: [{ id: 'page_1', name: 'SmallSeed' }] } },
      { status: 200, body: { images: { 'hero.png': { hash: 'hash_img_1' } } } },
      { status: 200, body: { id: 'meta_cmp_1' } },
      { status: 200, body: { id: 'meta_set_1' } },
      { status: 200, body: { id: 'meta_cr_1' } },
      { status: 200, body: { id: 'meta_ad_1' } },
    ]);
    const adapter = new MetaAdsAdapter({ accessToken: 'tok', adAccountId: 'act_123' }, http);
    const result = await adapter.mutate(createCommand());
    expect(result).toEqual({
      kind: 'success',
      mapping: {
        provider: 'meta',
        providerCampaignId: 'meta_cmp_1',
        providerAdGroupId: 'meta_set_1',
        providerAdId: 'meta_ad_1',
        providerAccountId: 'act_123',
        launchKind: 'deliverable_ad',
        deliverableAd: true,
        clickUrlPushed: true,
      },
    });
    expect(http.calls[2]!.url).toContain('/act_123/adimages');
    expect(JSON.parse(http.calls[3]!.body ?? '{}').is_adset_budget_sharing_enabled).toBe(false);
    expect(JSON.parse(http.calls[4]!.body ?? '{}').bid_strategy).toBe('LOWEST_COST_WITHOUT_CAP');
    expect(JSON.parse(http.calls[4]!.body ?? '{}').dsa_beneficiary).toBe('SmallSeed');
    expect(JSON.parse(http.calls[4]!.body ?? '{}').dsa_payor).toBe('SmallSeed');
    expect(JSON.parse(http.calls[5]!.body ?? '{}').object_story_spec.link_data.image_hash).toBe('hash_img_1');
  });

  it('uploads mp4 video creative to advideos and creates video_data adcreative', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { id: 'act_123', account_status: 1 } },
      { status: 200, body: { data: [{ id: 'page_1' }] } },
      { status: 200, body: { id: 'vid_99' } },
      { status: 200, body: { id: 'meta_cmp_2' } },
      { status: 200, body: { id: 'meta_set_2' } },
      { status: 200, body: { id: 'meta_cr_2' } },
      { status: 200, body: { id: 'meta_ad_2' } },
    ]);
    const adapter = new MetaAdsAdapter({ accessToken: 'tok', adAccountId: '123' }, http);
    const result = await adapter.mutate(
      createCommand({
        args: {
          verb: 'ads.create_campaign',
          name: 'Video Launch',
          landingPageUrl: 'https://smallseedlabs.co.uk/',
          dailyBudget: 20,
          currency: 'USD',
          platform: 'meta',
          creative: {
            type: 'IMAGE',
            headline: 'Watch Proba',
            body: 'Demo video',
            mediaUrl: 'https://smallseedlabs.co.uk/demo.mp4',
          },
        },
      })
    );
    expect(result.kind).toBe('success');
    expect(http.calls[2]!.url).toContain('/act_123/advideos');
    expect(JSON.parse(http.calls[5]!.body ?? '{}').object_story_spec.video_data.video_id).toBe('vid_99');
  });

  it('pauses Meta campaign and fetches Insights metrics', async () => {
    const http = new ScriptedHttpTransport([
      { status: 200, body: { success: true } },
      { status: 200, body: { data: [{ date_start: '2026-11-14', impressions: '1200', clicks: '30', spend: '6.50', actions: [{ value: '4' }] }] } },
    ]);
    const adapter = new MetaAdsAdapter({ accessToken: 'tok', adAccountId: 'act_123' }, http);
    const pauseRes = await adapter.mutate({
      workspaceId: 'ws_1',
      userId: 'u_1',
      verb: 'ads.pause_campaign',
      platform: 'meta',
      probaCampaignId: 'pc_1',
      providerCampaignId: 'meta_cmp_1',
      args: { verb: 'ads.pause_campaign', probaCampaignId: 'pc_1' },
    });
    expect(pauseRes.kind).toBe('success');

    const metricsRes = await adapter.fetchCampaignMetrics({
      workspaceId: 'ws_1',
      userId: 'u_1',
      probaCampaignId: 'pc_1',
      providerAccountId: 'act_123',
      providerCampaignId: 'meta_cmp_1',
      periodStart: '2026-11-01T00:00:00.000Z',
      periodEnd: '2026-11-14T23:59:59.000Z',
      granularity: 'day',
      timezone: 'UTC',
      fetchedAt: '2026-11-14T12:00:00.000Z',
      reportMaxPages: 1,
    });
    expect(metricsRes).toEqual({
      kind: 'ok',
      observations: [
        {
          version: 1,
          platform: 'meta',
          accountId: 'act_123',
          campaignId: 'meta_cmp_1',
          granularity: 'day',
          periodStart: '2026-11-14T00:00:00.000Z',
          periodEnd: '2026-11-14T23:59:59.000Z',
          metrics: { impressions: 1200, clicks: 30, spend: 6.5, conversions: 4 },
          currency: 'USD',
          fetchedAt: '2026-11-14T12:00:00.000Z',
          timezone: 'UTC',
          revision: 0,
        },
      ],
      quarantined: [],
      pages: 1,
    });
  });
});
