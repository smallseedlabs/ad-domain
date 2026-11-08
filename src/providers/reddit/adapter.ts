import type { AdPlatform } from '../../types/http.js';
import type { AdsBillingClaim } from '../../types/preflight.js';
import type { HttpTransport } from '../http.js';
import type { MetricsFetchOutcome, MetricsFetchQuery } from '../metrics.js';
import type { ProviderAdapter, ProviderCommand, ProviderOutcome } from '../port.js';
import { RedditAdsClient, type RedditHttpKind } from './client.js';
import { toRedditScheduleFields, toRedditTargeting } from '../../domain/targeting.js';
import {
  REDDIT_POST_JOB_MAX_GETS,
  REDDIT_REPORT_DEFAULT_MAX_PAGES,
  REDDIT_REPORT_PAGE_SIZE,
  redditConversionPixelId,
  redditCreatePrerequisiteError,
  type RedditAdsConfig,
} from './config.js';
import { toMicros } from './money.js';
import { normalizeRedditMetrics, parseRedditReportPage } from './normalize-metrics.js';
import { jobPostId, jobStatus, toRedditStructuredPostData } from './structured-post.js';
import { redditSameOrigin, toRedditHourUtc } from './time.js';

const SCAFFOLD_MAPPING = {
  launchKind: 'campaign_ad_group_scaffold' as const,
  deliverableAd: false,
  clickUrlPushed: false,
  missingEntities: ['ad', 'creative', 'click_url'] as const,
};

const DELIVERABLE_MAPPING = {
  launchKind: 'deliverable_ad' as const,
  deliverableAd: true,
  clickUrlPushed: true,
};

function idOf(data: Record<string, unknown> | undefined): string | undefined {
  const id = data?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function accountIdOf(data: Record<string, unknown> | undefined): string | undefined {
  const id = data?.ad_account_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function parseFundingList(result: { data?: unknown; raw?: unknown }): {
  rows: Record<string, unknown>[];
  incomplete: boolean;
} {
  const rows = Array.isArray(result.data)
    ? result.data.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
    : [];
  const pagination =
    result.raw && typeof result.raw === 'object'
      ? (result.raw as { pagination?: { next_url?: unknown } }).pagination
      : undefined;
  const incomplete = Boolean(typeof pagination?.next_url === 'string' && pagination.next_url.length > 0);
  return { rows, incomplete };
}

function servableInstrument(rows: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return rows.find((row) => row.is_servable === true);
}

function httpKindToOutcome(kind: RedditHttpKind, message: string): ProviderOutcome | null {
  if (kind === 'ok') return null;
  if (kind === 'ambiguous' || kind === 'timeout') {
    return { kind: 'ambiguous', code: 'outcome_ambiguous', message };
  }
  if (kind === 'rate_limited') {
    return { kind: 'refused', code: 'provider_rate_limited', message };
  }
  if (kind === 'unauthorized') {
    return { kind: 'refused', code: 'provider_unauthorized', message };
  }
  if (kind === 'not_found') {
    return { kind: 'refused', code: 'ownership_mismatch', message };
  }
  return { kind: 'refused', code: 'provider_refused', message };
}

/**
 * Reddit Ads API v3 adapter. Registered only when config enables it.
 * Transport is injected; production uses fetch, tests use ScriptedHttpTransport.
 * Does not refresh OAuth tokens. Does not treat missing billing as a zero balance.
 */
export class RedditAdsAdapter implements ProviderAdapter {
  readonly name = 'reddit';
  readonly configured = true;
  private readonly client: RedditAdsClient;

  constructor(
    private readonly reddit: RedditAdsConfig,
    transport: HttpTransport
  ) {
    this.client = new RedditAdsClient(reddit, transport);
  }

  async connectionState(_workspaceId: string, platform?: AdPlatform) {
    if (platform && platform !== 'reddit') {
      return { state: 'missing' as const, platform, message: 'this adapter only serves Reddit' };
    }
    const result = await this.client.getAdAccount(this.reddit.adAccountId);
    if (result.kind === 'ok') {
      return {
        state: 'ready' as const,
        platform: 'reddit' as const,
        message: 'Reddit ad account is reachable',
        accountId: this.reddit.adAccountId,
      };
    }
    if (result.kind === 'unauthorized') {
      return { state: 'unauthorized' as const, platform: 'reddit' as const, message: result.message };
    }
    if (result.kind === 'not_found') {
      return { state: 'missing' as const, platform: 'reddit' as const, message: result.message };
    }
    return { state: 'unavailable' as const, platform: 'reddit' as const, message: result.message };
  }

  async permissionState(_workspaceId: string, platform?: AdPlatform) {
    const connection = await this.connectionState(_workspaceId, platform);
    if (connection.state === 'ready') {
      return { state: 'ready' as const, actions: ['create', 'update', 'pause', 'resume'] };
    }
    if (connection.state === 'unauthorized') {
      return { state: 'unauthorized' as const, message: connection.message };
    }
    return { state: 'unavailable' as const, message: connection.message };
  }

  async billingClaim(_workspaceId: string, _platform?: AdPlatform): Promise<AdsBillingClaim> {
    const result = await this.client.listFundingInstruments(this.reddit.adAccountId);
    if (result.kind === 'ok') {
      const { rows, incomplete } = parseFundingList(result);
      const servable = servableInstrument(rows);
      if (!servable && incomplete) {
        return {
          kind: 'unknown',
          reason:
            'Reddit funding-instruments first page had no servable instrument and pagination continues. Eligibility is unknown, not a verified zero.',
        };
      }
      if (!servable) {
        return {
          kind: 'verified',
          mode: 'billing_eligibility',
          eligible: false,
          asOf: new Date().toISOString(),
          source: 'ads_domain',
        };
      }
      return {
        kind: 'verified',
        mode: 'billing_eligibility',
        eligible: true,
        asOf: new Date().toISOString(),
        source: 'ads_domain',
      };
    }
    if (result.kind === 'unauthorized') {
      return { kind: 'unavailable', reason: `Reddit funding instruments: ${result.message}` };
    }
    if (result.kind === 'not_found') {
      return {
        kind: 'unknown',
        reason:
          'Reddit funding-instruments endpoint returned 404. Billing eligibility is unknown, not a verified zero. Spend-increase is refused.',
      };
    }
    return {
      kind: 'unknown',
      reason: `Reddit funding instruments could not be read (${result.kind}: ${result.message}). This is not a verified balance.`,
    };
  }

  async mutate(command: ProviderCommand): Promise<ProviderOutcome> {
    if (command.platform !== 'reddit') {
      return { kind: 'refused', code: 'ownership_mismatch', message: 'Reddit adapter will not mutate a non-Reddit campaign' };
    }
    const accountId = command.providerAccountId ?? command.args.providerAccountId;
    if (accountId && accountId !== this.reddit.adAccountId) {
      return {
        kind: 'refused',
        code: 'ownership_mismatch',
        message: 'command provider account does not match the configured Reddit ad account',
      };
    }
    if (command.verb === 'ads.create_campaign') return this.create(command);
    if (command.verb === 'ads.pause_campaign') return this.setStatus(command, 'PAUSED');
    if (command.verb === 'ads.resume_campaign') return this.setStatus(command, 'ACTIVE');
    if (command.verb === 'ads.update_campaign') return this.update(command);
    return { kind: 'refused', code: 'provider_refused', message: `verb ${command.verb} is not supported by the Reddit adapter` };
  }

  /**
   * Read-only Get a Report. Does not POST/PATCH campaigns, ad groups, or ads.
   * Unread pagination is a failed fetch, not a verified empty window.
   */
  async fetchCampaignMetrics(query: MetricsFetchQuery): Promise<MetricsFetchOutcome> {
    if (query.providerAccountId !== this.reddit.adAccountId) {
      return {
        kind: 'refused',
        code: 'ownership_mismatch',
        message: 'metrics fetch provider account does not match the configured Reddit ad account',
      };
    }
    const remote = await this.client.getCampaign(query.providerCampaignId);
    if (remote.kind !== 'ok') {
      if (remote.kind === 'rate_limited') {
        return { kind: 'refused', code: 'provider_rate_limited', message: remote.message };
      }
      if (remote.kind === 'unauthorized') {
        return { kind: 'refused', code: 'provider_unauthorized', message: remote.message };
      }
      if (remote.kind === 'not_found') {
        return { kind: 'refused', code: 'ownership_mismatch', message: remote.message };
      }
      return { kind: 'refused', code: 'provider_unavailable', message: remote.message };
    }
    const remoteAccount = accountIdOf(remote.data);
    if (remoteAccount && remoteAccount !== this.reddit.adAccountId) {
      return { kind: 'refused', code: 'ownership_mismatch', message: 'Reddit campaign is not in the configured ad account' };
    }

    const maxPages = query.reportMaxPages || this.reddit.reportMaxPages || REDDIT_REPORT_DEFAULT_MAX_PAGES;
    const breakdowns = query.granularity === 'hour' ? (['CAMPAIGN_ID', 'HOUR'] as const) : (['CAMPAIGN_ID', 'DATE'] as const);
    const timeField = query.granularity === 'hour' ? 'DATETIME' : 'DATE';
    const first = await this.client.createReport(
      this.reddit.adAccountId,
      {
        breakdowns: [...breakdowns],
        fields: [
          'CAMPAIGN_ID',
          timeField,
          'IMPRESSIONS',
          'CLICKS',
          'SPEND',
          'CURRENCY',
          'KEY_CONVERSION_TOTAL_COUNT',
          'REACH',
          'VIDEO_VIEWABLE_IMPRESSIONS',
        ],
        starts_at: toRedditHourUtc(query.periodStart),
        ends_at: toRedditHourUtc(query.periodEnd),
        time_zone_id: 'UTC',
        filter: `campaign:id==${query.providerCampaignId}`,
      },
      REDDIT_REPORT_PAGE_SIZE
    );
    if (first.kind !== 'ok') {
      if (first.kind === 'rate_limited') {
        return { kind: 'refused', code: 'provider_rate_limited', message: first.message };
      }
      if (first.kind === 'unauthorized') {
        return { kind: 'refused', code: 'provider_unauthorized', message: first.message };
      }
      return { kind: 'refused', code: 'provider_unavailable', message: first.message };
    }

    const pages: ReturnType<typeof parseRedditReportPage>[] = [parseRedditReportPage(first.raw, first.data)];
    while (pages[pages.length - 1]?.nextUrl) {
      if (pages.length >= maxPages) {
        return {
          kind: 'refused',
          code: 'provider_page_limit',
          message: `Reddit report pagination exceeded REDDIT_REPORT_MAX_PAGES=${maxPages}. Unread pages were not treated as zeros.`,
        };
      }
      const nextUrl = pages[pages.length - 1]!.nextUrl!;
      if (!redditSameOrigin(this.reddit.apiBaseUrl, nextUrl)) {
        return {
          kind: 'refused',
          code: 'provider_refused',
          message: 'Reddit pagination.next_url left the configured Ads API origin and was not followed',
        };
      }
      const next = await this.client.followReportUrl(nextUrl);
      if (next.kind !== 'ok') {
        if (next.kind === 'rate_limited') {
          return { kind: 'refused', code: 'provider_rate_limited', message: next.message };
        }
        return {
          kind: 'refused',
          code: 'provider_unavailable',
          message: `Reddit report page ${pages.length + 1} failed: ${next.message}. Partial pages were not ingested as a complete window.`,
        };
      }
      pages.push(parseRedditReportPage(next.raw, next.data));
    }

    const rows = pages.flatMap((page) => page.metrics);
    const normalized = normalizeRedditMetrics(rows, {
      accountId: this.reddit.adAccountId,
      expectedCampaignId: query.providerCampaignId,
      granularity: query.granularity,
      timezone: query.timezone,
      fetchedAt: query.fetchedAt,
    });
    return {
      kind: 'ok',
      observations: normalized.observations,
      quarantined: normalized.quarantined,
      pages: pages.length,
    };
  }

  private async create(command: ProviderCommand): Promise<ProviderOutcome> {
    const pixelId = redditConversionPixelId(this.reddit.conversionPixelId);
    const prerequisite = redditCreatePrerequisiteError(this.reddit);
    const landingPageUrl = command.landingPageUrl ?? command.args.landingPageUrl;
    if (prerequisite || !pixelId) {
      return {
        kind: 'refused',
        code: 'provider_prerequisites_missing',
        message: prerequisite ?? 'REDDIT_CONVERSION_PIXEL_ID is required before creating a Reddit campaign or ad group. No remote create was sent.',
      };
    }
    if (!landingPageUrl) {
      return {
        kind: 'refused',
        code: 'provider_prerequisites_missing',
        message: 'landingPageUrl is required before Reddit ad create; no default destination is applied. No remote create was sent.',
      };
    }
    if (!command.args.researchAcceptance) {
      return {
        kind: 'refused',
        code: 'provider_prerequisites_missing',
        message:
          'researchAcceptance is required before create. Ads does not call Hub and does not treat missing research as accepted. No remote create was sent.',
      };
    }
    if (command.platform !== 'reddit' && (command.args.creative || command.args.targeting || command.args.schedule)) {
      return {
        kind: 'refused',
        code: 'ownership_mismatch',
        message: 'creative/targeting/schedule mutations are Reddit-only; this adapter will not apply them to another provider',
      };
    }

    const resolvedPost = await this.resolvePostId(command, landingPageUrl);
    if (!('postId' in resolvedPost)) return resolvedPost;
    const createdPostId = resolvedPost.postId;

    const createdViaJob = !command.args.providerPostId;
    const post = await this.client.getStructuredPost(createdPostId);
    if (post.kind !== 'ok') {
      if (post.kind === 'rate_limited') {
        return { kind: 'refused', code: 'provider_rate_limited', message: post.message };
      }
      if (post.kind === 'unauthorized') {
        return { kind: 'refused', code: 'provider_unauthorized', message: post.message };
      }
      if (createdViaJob && (post.kind === 'timeout' || post.kind === 'ambiguous' || post.kind === 'unavailable')) {
        return {
          kind: 'ambiguous',
          code: 'outcome_ambiguous',
          message: `Reddit structured post ${createdPostId} may exist after the creation job; GET was uncertain (${post.kind}: ${post.message}). Not retried as success. No campaign was sent.`,
        };
      }
      return {
        kind: 'refused',
        code: 'provider_prerequisites_missing',
        message: `Reddit structured post ${createdPostId} was not retrievable before create (${post.kind}: ${post.message}). No campaign was sent.`,
      };
    }

    const funding = await this.client.listFundingInstruments(this.reddit.adAccountId);
    if (funding.kind !== 'ok') {
      if (funding.kind === 'rate_limited') {
        return { kind: 'refused', code: 'provider_rate_limited', message: funding.message };
      }
      if (funding.kind === 'unauthorized') {
        return { kind: 'refused', code: 'provider_unauthorized', message: funding.message };
      }
      return { kind: 'refused', code: 'billing_not_ready', message: funding.message };
    }
    const { rows, incomplete } = parseFundingList(funding);
    const servable = servableInstrument(rows);
    if (!servable || typeof servable.id !== 'string') {
      return {
        kind: 'refused',
        code: 'billing_not_ready',
        message: incomplete
          ? 'Reddit funding-instruments page was incomplete and no servable instrument was visible; billing is unknown'
          : 'no servable Reddit funding instrument for this ad account',
      };
    }
    if (command.args.currency && typeof servable.currency === 'string' && servable.currency !== command.args.currency) {
      return {
        kind: 'refused',
        code: 'billing_not_ready',
        message: `Reddit funding instrument currency ${servable.currency} does not match ${command.args.currency}`,
      };
    }

    const created = await this.client.createCampaign(this.reddit.adAccountId, {
      name: command.args.name,
      configured_status: 'ACTIVE',
      objective: 'CLICKS',
      funding_instrument_id: servable.id,
    });
    if (created.kind !== 'ok') {
      return httpKindToOutcome(created.kind, created.message) ?? { kind: 'refused', code: 'provider_refused', message: created.message };
    }
    const campaignId = idOf(created.data);
    if (!campaignId) {
      return { kind: 'ambiguous', code: 'outcome_ambiguous', message: 'Reddit accepted create but returned no campaign id' };
    }
    const remoteAccount = accountIdOf(created.data);
    if (remoteAccount && remoteAccount !== this.reddit.adAccountId) {
      return {
        kind: 'ambiguous',
        code: 'outcome_ambiguous',
        message: 'Reddit campaign was created under a different ad account than configured; not claimed as success',
      };
    }

    let adGroupId: string | undefined;
    if (typeof command.args.dailyBudget === 'number') {
      const targeting = toRedditTargeting(command.args.targeting);
      const scheduleFields = toRedditScheduleFields(command.args.schedule);
      const group = await this.client.createAdGroup(this.reddit.adAccountId, {
        type: 'MANUAL',
        name: `${command.args.name ?? 'ad-group'}`.slice(0, 200),
        campaign_id: campaignId,
        configured_status: 'ACTIVE',
        goal_type: 'DAILY_SPEND',
        goal_value: toMicros(command.args.dailyBudget),
        bid_type: 'CPC',
        bid_strategy: 'BIDLESS',
        bid_value: null,
        conversion_pixel_id: pixelId,
        ...(targeting ? { targeting } : {}),
        ...scheduleFields,
      });
      if (group.kind === 'ok') {
        adGroupId = idOf(group.data);
      } else if (group.kind === 'ambiguous' || group.kind === 'timeout') {
        return {
          kind: 'ambiguous',
          code: 'outcome_ambiguous',
          message: `Reddit campaign ${campaignId} may exist; ad group create outcome is uncertain: ${group.message}`,
        };
      }
      // 4xx on ad group: campaign exists; persist campaign mapping and note missing ad group rather than claiming a live ad.
    }

    if (!adGroupId) {
      return {
        kind: 'success',
        mapping: {
          provider: 'reddit',
          providerCampaignId: campaignId,
          providerAccountId: this.reddit.adAccountId,
          ...SCAFFOLD_MAPPING,
          missingEntities: ['ad_group', 'ad', 'creative', 'click_url'],
        },
      };
    }

    const ad = await this.client.createAd(this.reddit.adAccountId, {
      ad_group_id: adGroupId,
      name: command.args.name,
      post_id: createdPostId,
      click_url: landingPageUrl,
      configured_status: 'ACTIVE',
    });
    if (ad.kind !== 'ok') {
      if (ad.kind === 'ambiguous' || ad.kind === 'timeout') {
        return {
          kind: 'ambiguous',
          code: 'outcome_ambiguous',
          message: `Reddit campaign ${campaignId} and ad group ${adGroupId} may exist; ad create outcome is uncertain: ${ad.message}`,
        };
      }
      return {
        kind: 'success',
        mapping: {
          provider: 'reddit',
          providerCampaignId: campaignId,
          providerAdGroupId: adGroupId,
          providerAccountId: this.reddit.adAccountId,
          ...SCAFFOLD_MAPPING,
          missingEntities: ['ad', 'click_url'],
        },
      };
    }
    const adId = idOf(ad.data);
    if (!adId) {
      return {
        kind: 'ambiguous',
        code: 'outcome_ambiguous',
        message: `Reddit accepted ad create for campaign ${campaignId} but returned no ad id`,
      };
    }

    return {
      kind: 'success',
      mapping: {
        provider: 'reddit',
        providerCampaignId: campaignId,
        providerAdGroupId: adGroupId,
        providerAdId: adId,
        providerAccountId: this.reddit.adAccountId,
        ...DELIVERABLE_MAPPING,
      },
    };
  }

  private async resolvePostId(
    command: ProviderCommand,
    landingPageUrl: string
  ): Promise<ProviderOutcome | { postId: string }> {
    if (command.args.providerPostId) {
      return { postId: command.args.providerPostId };
    }
    const creative = command.args.creative;
    if (!creative) {
      return {
        kind: 'refused',
        code: 'provider_prerequisites_missing',
        message:
          'creative (approved copy/media) or existing providerPostId is required. Ads will not invent a Reddit post. No remote create was sent.',
      };
    }

    const profile = await this.resolveProfile(command.args.providerProfileId);
    if (!('id' in profile)) return profile;

    const created = await this.client.createStructuredPostJob(profile.id, toRedditStructuredPostData(creative, landingPageUrl));
    if (created.kind !== 'ok') {
      return httpKindToOutcome(created.kind, created.message) ?? { kind: 'refused', code: 'provider_refused', message: created.message };
    }
    const jobId = idOf(created.data);
    if (!jobId) {
      return {
        kind: 'ambiguous',
        code: 'outcome_ambiguous',
        message: 'Reddit accepted structured post job create but returned no job id; not retried',
      };
    }

    let latest = created.data;
    for (let i = 0; i < REDDIT_POST_JOB_MAX_GETS; i++) {
      const status = jobStatus(latest);
      const postId = jobPostId(latest);
      // Official POST job schema may omit post_id; GET /structured_posts/jobs/{id} is the documented source.
      if (status === 'SUCCESS' && postId) return { postId };
      if (status === 'SUCCESS' && !postId && i > 0) {
        return {
          kind: 'ambiguous',
          code: 'outcome_ambiguous',
          message: `Reddit structured post job ${jobId} is SUCCESS but post_id is missing; not claimed as a launch`,
        };
      }
      if (status === 'CLIENT_ERROR') {
        const err = latest?.error_message;
        return {
          kind: 'refused',
          code: 'provider_refused',
          message: `Reddit structured post job ${jobId} CLIENT_ERROR${typeof err === 'string' ? `: ${err}` : ''}. No campaign was sent.`,
        };
      }
      if (status === 'SERVER_ERROR') {
        return {
          kind: 'ambiguous',
          code: 'outcome_ambiguous',
          message: `Reddit structured post job ${jobId} SERVER_ERROR; post may exist. Not retried as success.`,
        };
      }
      const polled = await this.client.getStructuredPostJob(jobId);
      if (polled.kind !== 'ok') {
        if (polled.kind === 'rate_limited') {
          return { kind: 'refused', code: 'provider_rate_limited', message: polled.message };
        }
        if (polled.kind === 'unauthorized') {
          return { kind: 'refused', code: 'provider_unauthorized', message: polled.message };
        }
        if (polled.kind === 'timeout' || polled.kind === 'ambiguous') {
          return {
            kind: 'ambiguous',
            code: 'outcome_ambiguous',
            message: `Reddit structured post job ${jobId} poll is uncertain: ${polled.message}`,
          };
        }
        return {
          kind: 'refused',
          code: 'provider_prerequisites_missing',
          message: `Reddit structured post job ${jobId} could not be read (${polled.kind}: ${polled.message}). No campaign was sent.`,
        };
      }
      latest = polled.data;
    }
    return {
      kind: 'ambiguous',
      code: 'outcome_ambiguous',
      message: `Reddit structured post job ${jobId} still QUEUED/PROCESSING after ${REDDIT_POST_JOB_MAX_GETS} GETs; post may complete later. Not retried.`,
    };
  }

  private async resolveProfile(requestedId: string | undefined): Promise<ProviderOutcome | { id: string }> {
    const listed = await this.client.listProfilesByAdAccount(this.reddit.adAccountId);
    if (listed.kind !== 'ok') {
      if (listed.kind === 'rate_limited') {
        return { kind: 'refused', code: 'provider_rate_limited', message: listed.message };
      }
      if (listed.kind === 'unauthorized') {
        return { kind: 'refused', code: 'provider_unauthorized', message: listed.message };
      }
      return {
        kind: 'refused',
        code: 'provider_prerequisites_missing',
        message: `Reddit profiles could not be listed for this ad account (${listed.kind}: ${listed.message}). Ads does not invent profile_id. No post job was sent.`,
      };
    }
    const rows = Array.isArray(listed.data)
      ? listed.data.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
      : [];
    const raw = listed.raw && typeof listed.raw === 'object' ? (listed.raw as { pagination?: { next_url?: unknown }; next_url?: unknown }) : undefined;
    const pageNext = raw?.pagination?.next_url;
    const envelopeNext = raw?.next_url;
    const incomplete = Boolean(
      (typeof pageNext === 'string' && pageNext.length > 0) || (typeof envelopeNext === 'string' && envelopeNext.length > 0)
    );
    const ids = rows.map((row) => row.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (requestedId) {
      if (ids.includes(requestedId)) return { id: requestedId };
      if (incomplete) {
        return {
          kind: 'refused',
          code: 'provider_prerequisites_missing',
          message:
            'Reddit profile list was paginated and the requested providerProfileId was not on the first page. Ads does not follow profile next_url in this slice. No post job was sent.',
        };
      }
      return {
        kind: 'refused',
        code: 'ownership_mismatch',
        message: 'providerProfileId is not in the configured Reddit ad account profile list',
      };
    }
    if (ids.length === 1) return { id: ids[0]! };
    if (ids.length === 0) {
      return {
        kind: 'refused',
        code: 'provider_prerequisites_missing',
        message: incomplete
          ? 'Reddit profile first page was empty with pagination continuing; profile_id is unknown, not invented'
          : 'no Reddit profiles are listed for this ad account; Ads does not invent profile_id',
      };
    }
    return {
      kind: 'refused',
      code: 'provider_prerequisites_missing',
      message: 'multiple Reddit profiles are listed; pass providerProfileId. Ads will not pick one.',
    };
  }

  private async requireOwnedCampaign(command: ProviderCommand): Promise<ProviderOutcome | { id: string }> {
    const campaignId = command.providerCampaignId;
    if (!campaignId) {
      return { kind: 'refused', code: 'ownership_mismatch', message: 'campaign is not mapped to a Reddit campaign id' };
    }
    const remote = await this.client.getCampaign(campaignId);
    if (remote.kind !== 'ok') {
      return httpKindToOutcome(remote.kind, remote.message) ?? { kind: 'refused', code: 'provider_refused', message: remote.message };
    }
    const remoteAccount = accountIdOf(remote.data);
    if (remoteAccount && remoteAccount !== this.reddit.adAccountId) {
      return { kind: 'refused', code: 'ownership_mismatch', message: 'Reddit campaign is not in the configured ad account' };
    }
    return { id: campaignId };
  }

  private async setStatus(command: ProviderCommand, status: 'ACTIVE' | 'PAUSED'): Promise<ProviderOutcome> {
    const owned = await this.requireOwnedCampaign(command);
    if (!('id' in owned)) return owned;
    const updated = await this.client.updateCampaign(owned.id, { configured_status: status });
    if (updated.kind !== 'ok') {
      return httpKindToOutcome(updated.kind, updated.message) ?? { kind: 'refused', code: 'provider_refused', message: updated.message };
    }
    return {
      kind: 'success',
      mapping: {
        provider: 'reddit',
        providerCampaignId: owned.id,
        providerAdGroupId: command.providerAdGroupId,
        providerAdId: command.providerAdId,
        providerAccountId: this.reddit.adAccountId,
      },
    };
  }

  private async update(command: ProviderCommand): Promise<ProviderOutcome> {
    const owned = await this.requireOwnedCampaign(command);
    if (!('id' in owned)) return owned;
    const patch: Record<string, unknown> = {};
    if (command.args.name) patch.name = command.args.name;
    if (Object.keys(patch).length > 0) {
      const campaignPatch = await this.client.updateCampaign(owned.id, patch);
      if (campaignPatch.kind !== 'ok') {
        return (
          httpKindToOutcome(campaignPatch.kind, campaignPatch.message) ?? {
            kind: 'refused',
            code: 'provider_refused',
            message: campaignPatch.message,
          }
        );
      }
    }
    if (typeof command.args.dailyBudget === 'number') {
      if (!command.providerAdGroupId) {
        return {
          kind: 'refused',
          code: 'provider_refused',
          message: 'campaign has no Reddit ad group mapping; daily budget cannot be applied (non-CBO budget lives on the ad group)',
        };
      }
      const group = await this.client.updateAdGroup(command.providerAdGroupId, {
        goal_value: toMicros(command.args.dailyBudget),
      });
      if (group.kind !== 'ok') {
        return httpKindToOutcome(group.kind, group.message) ?? { kind: 'refused', code: 'provider_refused', message: group.message };
      }
    }
    if (command.args.landingPageUrl) {
      if (!command.providerAdId) {
        return {
          kind: 'refused',
          code: 'provider_prerequisites_missing',
          message:
            'Reddit click_url is an ad-level field; this campaign has no providerAdId so landingPageUrl cannot be pushed. Not claimed as a launch.',
        };
      }
      const patched = await this.client.updateAd(command.providerAdId, { click_url: command.args.landingPageUrl });
      if (patched.kind !== 'ok') {
        return httpKindToOutcome(patched.kind, patched.message) ?? { kind: 'refused', code: 'provider_refused', message: patched.message };
      }
    }
    return {
      kind: 'success',
      mapping: {
        provider: 'reddit',
        providerCampaignId: owned.id,
        providerAdGroupId: command.providerAdGroupId,
        providerAdId: command.providerAdId,
        providerAccountId: this.reddit.adAccountId,
        ...(command.providerAdId && command.args.landingPageUrl
          ? { launchKind: 'deliverable_ad' as const, deliverableAd: true, clickUrlPushed: true }
          : {}),
      },
    };
  }
}
