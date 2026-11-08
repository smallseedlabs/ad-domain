import type { AdPlatform } from '../types/http.js';
import type { AdsBillingClaim } from '../types/preflight.js';
import type { ParsedAdsArgs } from '../domain/verbs.js';
import type { MetricsFetchOutcome, MetricsFetchQuery } from './metrics.js';

export interface ProviderMapping {
  provider: AdPlatform;
  providerCampaignId: string;
  providerAdGroupId?: string;
  providerAdId?: string;
  providerAccountId?: string;
  /** Present when the adapter created only campaign/ad-group entities, not a deliverable ad. */
  launchKind?: 'campaign_ad_group_scaffold' | 'deliverable_ad';
  deliverableAd?: boolean;
  clickUrlPushed?: boolean;
  missingEntities?: readonly string[];
}

export type ProviderOutcome =
  | { kind: 'success'; mapping: ProviderMapping }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'ambiguous'; code: string; message: string }
  | { kind: 'unconfigured'; message: string };

export interface ProviderCommand {
  workspaceId: string;
  userId: string;
  verb: ParsedAdsArgs['verb'];
  args: ParsedAdsArgs;
  platform: AdPlatform;
  probaCampaignId: string;
  landingPageUrl?: string;
  providerAccountId?: string;
  providerCampaignId?: string;
  providerAdGroupId?: string;
  providerAdId?: string;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly configured: boolean;
  mutate(command: ProviderCommand): Promise<ProviderOutcome>;
  connectionState(workspaceId: string, platform?: AdPlatform): Promise<{
    state: 'ready' | 'missing' | 'unauthorized' | 'unknown' | 'unavailable';
    platform?: AdPlatform;
    message?: string;
    accountId?: string;
  }>;
  permissionState(workspaceId: string, platform?: AdPlatform): Promise<{
    state: 'ready' | 'unauthorized' | 'unknown' | 'unavailable';
    actions?: string[];
    message?: string;
  }>;
  billingClaim(workspaceId: string, platform?: AdPlatform): Promise<AdsBillingClaim>;
  /** Read-only metrics pull. Must not create/pause/resume/update campaigns. */
  fetchCampaignMetrics(query: MetricsFetchQuery): Promise<MetricsFetchOutcome>;
}
