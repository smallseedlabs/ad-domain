import type { AdPlatform } from '../types/http.js';
import type { AdsBillingClaim } from '../types/preflight.js';
import type { MetricsFetchOutcome, MetricsFetchQuery } from './metrics.js';
import type { ProviderAdapter, ProviderCommand, ProviderOutcome } from './port.js';

/**
 * Default until a later provider-adapter task. Never reports a successful
 * mutation. Billing is unknown, not a verified zero.
 */
export class UnconfiguredProvider implements ProviderAdapter {
  readonly name = 'unconfigured';
  readonly configured = false;

  async mutate(_command: ProviderCommand): Promise<ProviderOutcome> {
    return {
      kind: 'unconfigured',
      message:
        'No provider adapter is configured (Reddit/Microsoft/Google/Meta modules are not in this slice). Mutation is refused; no side effect was attempted.',
    };
  }

  async connectionState(_workspaceId: string, platform?: AdPlatform) {
    return {
      state: 'missing' as const,
      platform,
      message: 'provider connection is unconfigured; no adapter is registered',
    };
  }

  async permissionState(_workspaceId: string, _platform?: AdPlatform) {
    return {
      state: 'unavailable' as const,
      message: 'provider permissions cannot be checked without a configured adapter',
    };
  }

  async billingClaim(_workspaceId: string, _platform?: AdPlatform): Promise<AdsBillingClaim> {
    return {
      kind: 'unknown',
      reason:
        'provider billing cannot be queried; adapters are unconfigured. This is not a verified zero or nonzero balance',
    };
  }

  async fetchCampaignMetrics(_query: MetricsFetchQuery): Promise<MetricsFetchOutcome> {
    return {
      kind: 'unconfigured',
      message:
        'No provider adapter is configured. Metrics were not fetched and no campaign mutation was attempted.',
    };
  }
}
