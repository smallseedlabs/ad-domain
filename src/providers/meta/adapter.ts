import type { AdPlatform } from '../../types/http.js';
import type { AdsBillingClaim } from '../../types/preflight.js';
import { HttpTimeoutError, type HttpTransport } from '../http.js';
import type { MetricsFetchOutcome, MetricsFetchQuery } from '../metrics.js';
import type { ProviderAdapter, ProviderCommand, ProviderOutcome } from '../port.js';

export const META_GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

export interface MetaAdapterConfig {
  accessToken: string;
  adAccountId: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
}

function normAccountId(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith('act_') ? trimmed : `act_${trimmed}`;
}

/**
 * Meta Marketing API v21.0 adapter behind `ProviderAdapter`.
 * Supports IMAGE and VIDEO creatives, full campaign -> adset -> adcreative -> ad launch,
 * budget updates, pause/resume, billing preflight, and Insights metrics pulls.
 */
export class MetaAdsAdapter implements ProviderAdapter {
  readonly name = 'meta';
  readonly configured = true;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly accountId: string;

  constructor(
    private readonly config: MetaAdapterConfig,
    private readonly http: HttpTransport
  ) {
    this.apiBase = (config.apiBaseUrl || META_GRAPH_API_BASE).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.accountId = normAccountId(config.adAccountId);
  }

  async connectionState(_workspaceId: string, _platform?: AdPlatform) {
    const res = await this.get(`${this.accountId}?fields=id,account_status,currency`);
    if (res.kind === 'timeout') return { state: 'unavailable' as const, platform: 'meta' as const, message: 'Meta Graph API timed out' };
    if (res.status === 401 || res.status === 403) return { state: 'unauthorized' as const, platform: 'meta' as const, message: 'Meta token unauthorized' };
    if (res.status >= 400 || !res.body) return { state: 'unavailable' as const, platform: 'meta' as const, message: `Meta answered ${res.status}` };
    return { state: 'ready' as const, platform: 'meta' as const, accountId: this.accountId };
  }

  async permissionState(_workspaceId: string, _platform?: AdPlatform) {
    const res = await this.get('me/permissions');
    if (res.kind === 'timeout' || res.status >= 500) return { state: 'unavailable' as const, message: 'Meta permissions check unavailable' };
    if (res.status === 401 || res.status === 403) return { state: 'unauthorized' as const, message: 'Meta token unauthorized' };
    const perms = Array.isArray((res.body as { data?: unknown[] } | null)?.data)
      ? ((res.body as { data: Array<{ permission?: string; status?: string }> }).data)
      : [];
    const granted = perms.filter((p) => p.status === 'granted').map((p) => p.permission ?? '');
    if (!granted.includes('ads_management')) {
      return { state: 'unauthorized' as const, actions: granted, message: 'Missing ads_management permission' };
    }
    return { state: 'ready' as const, actions: granted };
  }

  async billingClaim(_workspaceId: string, _platform?: AdPlatform): Promise<AdsBillingClaim> {
    const res = await this.get(`${this.accountId}?fields=id,account_status,funding_source_details`);
    if (res.kind === 'timeout' || res.status >= 500) return { kind: 'unavailable', reason: 'Meta billing check unavailable' };
    if (res.status === 401 || res.status === 403) return { kind: 'unavailable', reason: 'Meta token unauthorized' };
    const status = (res.body as { account_status?: number } | null)?.account_status;
    return {
      kind: 'verified',
      mode: 'billing_eligibility',
      eligible: status === 1,
      asOf: new Date().toISOString(),
      source: 'ads_domain',
    };
  }

  async mutate(command: ProviderCommand): Promise<ProviderOutcome> {
    if (command.verb === 'ads.pause_campaign' || command.verb === 'ads.resume_campaign') {
      if (!command.providerCampaignId) {
        return { kind: 'refused', code: 'missing_mapping', message: 'providerCampaignId is required to pause or resume' };
      }
      const status = command.verb === 'ads.pause_campaign' ? 'PAUSED' : 'ACTIVE';
      const res = await this.post(command.providerCampaignId, { status });
      if (res.kind === 'timeout') return { kind: 'ambiguous', code: 'provider_timeout', message: 'Meta campaign status update timed out' };
      if (res.status === 401 || res.status === 403) return { kind: 'refused', code: 'provider_unauthorized', message: 'Meta token unauthorized' };
      if (res.status >= 400) return { kind: 'refused', code: 'provider_refused', message: this.errMsg(res.body, res.status) };
      return {
        kind: 'success',
        mapping: {
          provider: 'meta',
          providerCampaignId: command.providerCampaignId,
          providerAdGroupId: command.providerAdGroupId,
          providerAdId: command.providerAdId,
          providerAccountId: this.accountId,
        },
      };
    }

    if (command.verb === 'ads.update_campaign') {
      const targetId = command.providerAdGroupId || command.providerCampaignId;
      if (!targetId) return { kind: 'refused', code: 'missing_mapping', message: 'No Meta ad set or campaign ID mapped' };
      const dailyBudget = typeof command.args.dailyBudget === 'number' ? command.args.dailyBudget : undefined;
      if (!dailyBudget || dailyBudget < 1) return { kind: 'refused', code: 'invalid_budget', message: 'Meta dailyBudget must be at least 1' };
      const res = await this.post(targetId, { daily_budget: Math.round(dailyBudget * 100) });
      if (res.kind === 'timeout') return { kind: 'ambiguous', code: 'provider_timeout', message: 'Meta budget update timed out' };
      if (res.status === 401 || res.status === 403) return { kind: 'refused', code: 'provider_unauthorized', message: 'Meta token unauthorized' };
      if (res.status >= 400) return { kind: 'refused', code: 'provider_refused', message: this.errMsg(res.body, res.status) };
      return {
        kind: 'success',
        mapping: {
          provider: 'meta',
          providerCampaignId: command.providerCampaignId ?? targetId,
          providerAdGroupId: command.providerAdGroupId,
          providerAdId: command.providerAdId,
          providerAccountId: this.accountId,
        },
      };
    }

    if (command.verb !== 'ads.create_campaign') {
      return { kind: 'refused', code: 'unsupported_verb', message: `Unsupported Meta verb ${command.verb}` };
    }

    const args = command.args;
    const accountRes = await this.get(`${this.accountId}?fields=id,account_status`);
    if (accountRes.kind === 'timeout') return { kind: 'refused', code: 'provider_unavailable', message: 'Meta account check timed out' };
    if (accountRes.status === 401 || accountRes.status === 403) return { kind: 'refused', code: 'provider_unauthorized', message: 'Meta token unauthorized' };
    if ((accountRes.body as { account_status?: number } | null)?.account_status !== 1) {
      return { kind: 'refused', code: 'billing_not_ready', message: 'Meta ad account is not active or lacks a funding source' };
    }

    let pageId = args.providerProfileId;
    let pageName: string | undefined;
    if (!pageId) {
      const pagesRes = await this.get('me/accounts?fields=id,name&limit=1');
      const pages = (pagesRes.body as { data?: Array<{ id?: string; name?: string }> } | null)?.data ?? [];
      pageId = pages[0]?.id;
      pageName = pages[0]?.name;
    }
    if (!pageId) {
      return { kind: 'refused', code: 'missing_page', message: 'No Facebook Page found for this Meta connection' };
    }

    const creative = args.creative;
    const landingPageUrl = args.landingPageUrl;
    let imageHash: string | undefined;
    let videoId: string | undefined;

    if (creative?.type === 'IMAGE' && creative.mediaUrl) {
      const lower = creative.mediaUrl.toLowerCase();
      if (lower.endsWith('.mp4') || lower.endsWith('.mov')) {
        const vidRes = await this.post(`${this.accountId}/advideos`, { file_url: creative.mediaUrl, name: args.name });
        if (vidRes.kind === 'timeout') return { kind: 'ambiguous', code: 'provider_timeout', message: 'Meta video upload timed out' };
        if (vidRes.status >= 400 || !(vidRes.body as { id?: string } | null)?.id) {
          return { kind: 'refused', code: 'media_upload_failed', message: this.errMsg(vidRes.body, vidRes.status) };
        }
        videoId = (vidRes.body as { id: string }).id;
      } else {
        const imgRes = await this.post(`${this.accountId}/adimages`, { url: creative.mediaUrl });
        if (imgRes.kind === 'timeout') return { kind: 'ambiguous', code: 'provider_timeout', message: 'Meta image upload timed out' };
        const imagesObj = (imgRes.body as { images?: Record<string, { hash?: string }> } | null)?.images;
        imageHash = imagesObj ? Object.values(imagesObj)[0]?.hash : undefined;
        if (imgRes.status >= 400 || !imageHash) {
          return { kind: 'refused', code: 'media_upload_failed', message: this.errMsg(imgRes.body, imgRes.status) };
        }
      }
    }

    const campRes = await this.post(`${this.accountId}/campaigns`, {
      name: args.name,
      objective: args.objective ?? 'OUTCOME_TRAFFIC',
      status: 'ACTIVE',
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
    });
    if (campRes.kind === 'timeout') return { kind: 'ambiguous', code: 'provider_timeout', message: 'Meta campaign create timed out' };
    const campaignId = (campRes.body as { id?: string } | null)?.id;
    if (campRes.status >= 400 || !campaignId) {
      return { kind: 'refused', code: 'provider_refused', message: this.errMsg(campRes.body, campRes.status) };
    }

    const dailyBudgetDollars = typeof args.dailyBudget === 'number' && args.dailyBudget > 0 ? args.dailyBudget : 10;
    const bidStrategy = args.bidStrategy ?? 'LOWEST_COST_WITHOUT_CAP';
    const countries = (args.targeting?.geolocations ?? [])
      .map((g) => g.trim().toUpperCase())
      .filter((g) => /^[A-Z]{2}$/.test(g));
    const adSetRes = await this.post(`${this.accountId}/adsets`, {
      name: `${args.name} Ad Set`,
      campaign_id: campaignId,
      daily_budget: Math.round(dailyBudgetDollars * 100),
      billing_event: args.billingEvent ?? 'IMPRESSIONS',
      optimization_goal: args.optimizationGoal ?? 'LINK_CLICKS',
      bid_strategy: bidStrategy,
      ...(typeof args.bidAmount === 'number' && args.bidAmount > 0
        ? { bid_amount: Math.round(args.bidAmount * 100) }
        : {}),
      ...(pageName ? { dsa_beneficiary: pageName, dsa_payor: pageName } : {}),
      targeting: { geo_locations: { countries: countries.length > 0 ? countries : ['US', 'GB'] } },
      status: 'ACTIVE',
    });
    if (adSetRes.kind === 'timeout') return { kind: 'ambiguous', code: 'provider_timeout', message: 'Meta ad set create timed out' };
    const adSetId = (adSetRes.body as { id?: string } | null)?.id;
    if (adSetRes.status >= 400 || !adSetId) {
      return { kind: 'refused', code: 'provider_refused', message: this.errMsg(adSetRes.body, adSetRes.status) };
    }

    const ctaType = args.ctaType ?? 'LEARN_MORE';
    const storySpec = videoId
      ? {
          page_id: pageId,
          video_data: {
            video_id: videoId,
            title: creative?.headline ?? args.name,
            message: creative?.body ?? creative?.headline ?? args.name,
            call_to_action: { type: ctaType, value: { link: landingPageUrl } },
          },
        }
      : {
          page_id: pageId,
          link_data: {
            link: landingPageUrl,
            name: creative?.headline ?? args.name,
            message: creative?.body ?? creative?.headline ?? args.name,
            ...(imageHash ? { image_hash: imageHash } : {}),
            call_to_action: { type: ctaType, value: { link: landingPageUrl } },
          },
        };

    const crRes = await this.post(`${this.accountId}/adcreatives`, {
      name: `${args.name} Creative`,
      object_story_spec: storySpec,
    });
    if (crRes.kind === 'timeout') return { kind: 'ambiguous', code: 'provider_timeout', message: 'Meta ad creative create timed out' };
    const creativeId = (crRes.body as { id?: string } | null)?.id;
    if (crRes.status >= 400 || !creativeId) {
      return { kind: 'refused', code: 'provider_refused', message: this.errMsg(crRes.body, crRes.status) };
    }

    const adRes = await this.post(`${this.accountId}/ads`, {
      name: `${args.name} Ad`,
      adset_id: adSetId,
      creative: { creative_id: creativeId },
      status: 'ACTIVE',
    });
    if (adRes.kind === 'timeout') return { kind: 'ambiguous', code: 'provider_timeout', message: 'Meta ad create timed out' };
    const adId = (adRes.body as { id?: string } | null)?.id;
    if (adRes.status >= 400 || !adId) {
      return { kind: 'refused', code: 'provider_refused', message: this.errMsg(adRes.body, adRes.status) };
    }

    return {
      kind: 'success',
      mapping: {
        provider: 'meta',
        providerCampaignId: campaignId,
        providerAdGroupId: adSetId,
        providerAdId: adId,
        providerAccountId: this.accountId,
        launchKind: 'deliverable_ad',
        deliverableAd: true,
        clickUrlPushed: true,
      },
    };
  }

  async fetchCampaignMetrics(query: MetricsFetchQuery): Promise<MetricsFetchOutcome> {
    const campaignId = query.providerCampaignId;
    if (!campaignId) return { kind: 'refused', code: 'missing_mapping', message: 'providerCampaignId required' };
    const res = await this.get(
      `${encodeURIComponent(campaignId)}/insights?fields=impressions,clicks,spend,reach,actions,date_start,date_stop&time_increment=1&date_preset=last_14d`
    );
    if (res.kind === 'timeout') return { kind: 'refused', code: 'provider_unavailable', message: 'Meta insights timed out' };
    if (res.status === 401 || res.status === 403) return { kind: 'refused', code: 'provider_unauthorized', message: 'Meta token unauthorized' };
    if (res.status >= 400) return { kind: 'refused', code: 'provider_unavailable', message: this.errMsg(res.body, res.status) };

    const rows = Array.isArray((res.body as { data?: unknown[] } | null)?.data)
      ? ((res.body as { data: Array<Record<string, unknown>> }).data)
      : [];
    return {
      kind: 'ok',
      observations: rows.map((r) => {
        const actions = Array.isArray(r.actions) ? (r.actions as Array<{ value?: string }>) : [];
        const conversions = actions.reduce((acc, a) => acc + (Number(a.value ?? 0) || 0), 0);
        const periodStart = typeof r.date_start === 'string' ? `${r.date_start}T00:00:00.000Z` : query.periodStart;
        const periodEnd = typeof r.date_stop === 'string' ? `${r.date_stop}T23:59:59.999Z` : query.periodEnd;
        return {
          version: 1,
          platform: 'meta',
          accountId: this.accountId,
          campaignId,
          granularity: query.granularity,
          periodStart,
          periodEnd,
          metrics: {
            impressions: Number(r.impressions ?? 0) || 0,
            clicks: Number(r.clicks ?? 0) || 0,
            spend: Number(r.spend ?? 0) || 0,
            conversions,
            ...(r.reach !== undefined ? { reach: Number(r.reach) || 0 } : {}),
          },
          currency: 'USD',
          fetchedAt: query.fetchedAt,
          timezone: query.timezone,
          revision: 0,
        };
      }),
      quarantined: [],
      pages: 1,
    };
  }

  private async get(path: string): Promise<{ kind: 'response'; status: number; body: unknown } | { kind: 'timeout'; status: 0; body: null }> {
    try {
      const res = await this.http.request({
        method: 'GET',
        url: `${this.apiBase}/${path.replace(/^\/+/, '')}`,
        headers: {
          authorization: `Bearer ${this.config.accessToken}`,
          accept: 'application/json',
        },
        timeoutMs: this.timeoutMs,
      });
      return { kind: 'response', status: res.status, body: this.parseJson(res.bodyText) };
    } catch (err) {
      if (err instanceof HttpTimeoutError) return { kind: 'timeout', status: 0, body: null };
      throw err;
    }
  }

  private async post(path: string, body: Record<string, unknown>): Promise<{ kind: 'response'; status: number; body: unknown } | { kind: 'timeout'; status: 0; body: null }> {
    try {
      const res = await this.http.request({
        method: 'POST',
        url: `${this.apiBase}/${path.replace(/^\/+/, '')}`,
        headers: {
          authorization: `Bearer ${this.config.accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        timeoutMs: this.timeoutMs,
      });
      return { kind: 'response', status: res.status, body: this.parseJson(res.bodyText) };
    } catch (err) {
      if (err instanceof HttpTimeoutError) return { kind: 'timeout', status: 0, body: null };
      throw err;
    }
  }

  private parseJson(raw: unknown): unknown {
    if (typeof raw !== 'string') return raw ?? null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private errMsg(body: unknown, status: number): string {
    const err = (
      body as {
        error?: {
          message?: string;
          error_user_title?: string;
          error_user_msg?: string;
          error_subcode?: number;
        };
      } | null
    )?.error;
    if (!err) return `Meta Graph API answered ${status}`;
    const parts = [err.message, err.error_user_title, err.error_user_msg]
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
    const base = parts.join(' — ') || `Meta Graph API answered ${status}`;
    return err.error_subcode ? `${base} (subcode ${err.error_subcode})` : base;
  }
}
