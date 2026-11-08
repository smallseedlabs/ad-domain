import type { AdPlatform } from '../types/http.js';
import type { AdsBillingClaim } from '../types/preflight.js';
import type { ProviderAdapter, ProviderCommand, ProviderOutcome } from './port.js';

export type FakeMutateBehavior = 'success' | 'ambiguous' | 'refuse' | 'unconfigured';

/**
 * Test-only adapter. Refused outside NODE_ENV=test. Does not call a real
 * ad network and does not spend.
 */
export class FakeProvider implements ProviderAdapter {
  readonly name = 'fake';
  readonly configured = true;
  mutateBehavior: FakeMutateBehavior = 'success';
  billing: AdsBillingClaim = {
    kind: 'unknown',
    reason: 'fake provider has not been given a billing claim',
  };
  connection: 'ready' | 'missing' | 'unauthorized' = 'ready';
  accountId = 'acct-fake-1';
  platform: AdPlatform = 'reddit';

  async mutate(command: ProviderCommand): Promise<ProviderOutcome> {
    if (this.mutateBehavior === 'unconfigured') {
      return { kind: 'unconfigured', message: 'fake provider simulating unconfigured adapter' };
    }
    if (this.mutateBehavior === 'refuse') {
      return { kind: 'refused', code: 'provider_refused', message: 'fake provider refused the mutation' };
    }
    if (this.mutateBehavior === 'ambiguous') {
      return { kind: 'ambiguous', code: 'outcome_ambiguous', message: 'fake provider returned an ambiguous outcome' };
    }
    return {
      kind: 'success',
      mapping: {
        provider: command.platform,
        providerCampaignId: `fake-${command.probaCampaignId}`,
        providerAccountId: this.accountId,
      },
    };
  }

  async connectionState(_workspaceId: string, platform?: AdPlatform) {
    return {
      state: this.connection,
      platform: platform ?? this.platform,
      message: this.connection === 'ready' ? 'fake provider connection' : 'fake provider connection is not ready',
      accountId: this.connection === 'ready' ? this.accountId : undefined,
    };
  }

  async permissionState(_workspaceId: string, _platform?: AdPlatform) {
    if (this.connection !== 'ready') {
      return { state: 'unavailable' as const, message: 'fake provider permissions unavailable' };
    }
    return { state: 'ready' as const, actions: ['create', 'update', 'pause', 'resume'] };
  }

  async billingClaim(_workspaceId: string, _platform?: AdPlatform): Promise<AdsBillingClaim> {
    return this.billing;
  }
}

export function eligibleBillingClaim(now = new Date()): AdsBillingClaim {
  return {
    kind: 'verified',
    mode: 'billing_eligibility',
    eligible: true,
    asOf: now.toISOString(),
    source: 'ads_domain',
  };
}
