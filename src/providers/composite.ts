import type { AdPlatform } from '../types/http.js';
import type { AdsBillingClaim } from '../types/preflight.js';
import type { HttpTransport } from './http.js';
import type { MetricsFetchOutcome, MetricsFetchQuery } from './metrics.js';
import type { ProviderAdapter, ProviderCommand, ProviderOutcome } from './port.js';
import { UnconfiguredProvider } from './unconfigured.js';

/**
 * Dispatches ad operations and metrics queries by platform across registered `ProviderAdapter`
 * instances, falling back to `UnconfiguredProvider` for platforms not yet connected.
 */
export class CompositeProviderAdapter implements ProviderAdapter {
  readonly name = 'composite';
  readonly configured = true;
  private readonly fallback = new UnconfiguredProvider();

  constructor(private readonly adapters: Partial<Record<AdPlatform, ProviderAdapter>>) {}

  private pick(platform?: AdPlatform): ProviderAdapter {
    if (platform && this.adapters[platform]) return this.adapters[platform]!;
    return this.adapters.reddit ?? this.fallback;
  }

  connectionState(workspaceId: string, platform?: AdPlatform) {
    return this.pick(platform).connectionState(workspaceId, platform);
  }

  permissionState(workspaceId: string, platform?: AdPlatform) {
    return this.pick(platform).permissionState(workspaceId, platform);
  }

  billingClaim(workspaceId: string, platform?: AdPlatform): Promise<AdsBillingClaim> {
    return this.pick(platform).billingClaim(workspaceId, platform);
  }

  mutate(command: ProviderCommand): Promise<ProviderOutcome> {
    return this.pick(command.platform).mutate(command);
  }

  fetchCampaignMetrics(query: MetricsFetchQuery): Promise<MetricsFetchOutcome> {
    const inferredPlatform =
      (query as MetricsFetchQuery & { platform?: AdPlatform }).platform ??
      (query.providerAccountId.startsWith('act_') ? 'meta' : 'reddit');
    return this.pick(inferredPlatform).fetchCampaignMetrics(query);
  }
}

export type { HttpTransport };
