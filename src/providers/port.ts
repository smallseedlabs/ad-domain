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

/**
 * Which credential a provider call ran on: recorded on audit events so every campaign
 * action and metrics pull is traceable to the provider connection and account it used.
 * Never contains a token.
 */
export interface ProviderAttribution {
  source: 'broker' | 'file';
  providerAccountId: string;
  /** Hub platform connection id (broker only). */
  connectionId?: string;
  /** Hub user who connected the provider account (broker only). */
  connectedBy?: string;
}

export type ProviderOutcome = (
  | { kind: 'success'; mapping: ProviderMapping }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'ambiguous'; code: string; message: string }
  | { kind: 'unconfigured'; message: string }
) & { attribution?: ProviderAttribution };

/** user: an owner action or approval; policy: an owner-delegated action policy; system: Ads itself. */
export type ActionInitiator = 'user' | 'policy' | 'system';

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
  initiatedBy?: ActionInitiator;
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
  /**
   * Broker-backed adapters: the account the workspace's connection is on right now.
   * null = not connected / no account chosen (mappings are marked disconnected);
   * undefined = unknown right now (mappings are left unchanged).
   */
  syncAccountMapping?(workspaceId: string): Promise<{ accountId: string; connectionId: string } | null | undefined>;
}
