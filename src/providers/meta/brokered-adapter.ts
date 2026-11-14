import type { AdPlatform } from '../../types/http.js';
import type { AdsBillingClaim } from '../../types/preflight.js';
import type { HttpTransport } from '../http.js';
import type { MetricsFetchOutcome, MetricsFetchQuery } from '../metrics.js';
import type { ProviderAdapter, ProviderAttribution, ProviderCommand, ProviderOutcome } from '../port.js';
import type { CredentialRequest, CredentialResult, RedditCredentials, RedditCredentialSource } from '../reddit/credentials.js';
import { MetaAdsAdapter } from './adapter.js';

/**
 * Meta Ads adapter that resolves the workspace's access token and ad account ID from the
 * Hub connection broker (`provider: 'meta'`) and attributes every outcome to that connection.
 */
export class CredentialedMetaAdapter implements ProviderAdapter {
  readonly name = 'meta';
  readonly configured = true;

  constructor(
    private readonly source: RedditCredentialSource,
    private readonly transport: HttpTransport
  ) {}

  private async resolve(request: CredentialRequest): Promise<CredentialResult> {
    return this.source.get(request);
  }

  private delegate(credentials: RedditCredentials): MetaAdsAdapter {
    return new MetaAdsAdapter(
      { accessToken: credentials.accessToken, adAccountId: credentials.accountId },
      this.transport
    );
  }

  private attribution(credentials: RedditCredentials): ProviderAttribution {
    return {
      source: credentials.tokenSource,
      providerAccountId: credentials.accountId,
      ...(credentials.connectionId ? { connectionId: credentials.connectionId } : {}),
      ...(credentials.connectedBy ? { connectedBy: credentials.connectedBy } : {}),
    };
  }

  private invalidateOnUnauthorized(workspaceId: string, code: string | undefined): void {
    const invalidate = (this.source as { invalidate?: (ws: string) => void }).invalidate;
    if (invalidate && code === 'provider_unauthorized') invalidate.call(this.source, workspaceId);
  }

  async connectionState(workspaceId: string, platform?: AdPlatform) {
    const r = await this.resolve({ workspaceId, purpose: 'preflight' });
    if (!r.ok) {
      const state: 'unavailable' | 'unauthorized' | 'missing' =
        r.code === 'broker_unavailable' ? 'unavailable' : r.code === 'needs_reconnect' ? 'unauthorized' : 'missing';
      return { state, platform: 'meta' as const, message: `${r.code}: ${r.message}` };
    }
    return this.delegate(r.credentials).connectionState(workspaceId, platform);
  }

  async permissionState(workspaceId: string, platform?: AdPlatform) {
    const r = await this.resolve({ workspaceId, purpose: 'preflight' });
    if (!r.ok) {
      return { state: r.code === 'broker_unavailable' ? ('unavailable' as const) : ('unauthorized' as const), message: `${r.code}: ${r.message}` };
    }
    return this.delegate(r.credentials).permissionState(workspaceId, platform);
  }

  async billingClaim(workspaceId: string, platform?: AdPlatform): Promise<AdsBillingClaim> {
    const r = await this.resolve({ workspaceId, purpose: 'billing' });
    if (!r.ok) return { kind: 'unavailable', reason: `${r.code}: ${r.message}` };
    return this.delegate(r.credentials).billingClaim(workspaceId, platform);
  }

  async mutate(command: ProviderCommand): Promise<ProviderOutcome> {
    const r = await this.resolve({
      workspaceId: command.workspaceId,
      purpose: 'mutate',
      userId: command.userId,
      initiatedBy: command.initiatedBy ?? 'user',
    });
    if (!r.ok) return { kind: 'unconfigured', message: `Meta connection is not ready (${r.code}): ${r.message}. No remote call was sent.` };
    const outcome = await this.delegate(r.credentials).mutate(command);
    if (outcome.kind === 'refused') this.invalidateOnUnauthorized(command.workspaceId, outcome.code);
    return { ...outcome, attribution: this.attribution(r.credentials) };
  }

  async fetchCampaignMetrics(query: MetricsFetchQuery): Promise<MetricsFetchOutcome> {
    const r = await this.resolve({
      workspaceId: query.workspaceId,
      purpose: 'metrics',
      userId: query.userId,
      initiatedBy: 'system',
    });
    if (!r.ok) return { kind: 'unconfigured', message: `Meta connection is not ready (${r.code}): ${r.message}` };
    return this.delegate(r.credentials).fetchCampaignMetrics(query);
  }
}
