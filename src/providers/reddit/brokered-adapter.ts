import type { AdPlatform } from '../../types/http.js';
import type { AdsBillingClaim } from '../../types/preflight.js';
import type { RedditCommonConfig } from '../../types/config.js';
import type { HttpTransport } from '../http.js';
import type { MetricsFetchOutcome, MetricsFetchQuery } from '../metrics.js';
import type { ProviderAdapter, ProviderAttribution, ProviderCommand, ProviderOutcome } from '../port.js';
import { RedditAdsAdapter } from './adapter.js';
import type { CredentialRequest, CredentialResult, RedditCredentials, RedditCredentialSource } from './credentials.js';

/**
 * Reddit adapter that resolves the bearer token and ad account per workspace and per call
 * (from the Hub connection broker, or the static file fallback) and attributes every
 * outcome to the connection and account it ran on. The wrapped RedditAdsAdapter is unchanged.
 */
export class CredentialedRedditAdapter implements ProviderAdapter {
  readonly name = 'reddit';
  readonly configured = true;

  constructor(
    private readonly common: RedditCommonConfig,
    private readonly source: RedditCredentialSource,
    private readonly transport: HttpTransport
  ) {}

  private async resolve(request: CredentialRequest): Promise<CredentialResult> {
    return this.source.get(request);
  }

  private delegate(credentials: RedditCredentials): RedditAdsAdapter {
    return new RedditAdsAdapter(
      { enabled: true, ...this.common, adAccountId: credentials.accountId, accessToken: credentials.accessToken },
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
      return { state, platform: 'reddit' as const, message: `${r.code}: ${r.message}` };
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
    if (!r.ok) return { kind: 'unconfigured', message: `Reddit connection is not ready (${r.code}): ${r.message}. No remote call was sent.` };
    const outcome = await this.delegate(r.credentials).mutate(command);
    if (outcome.kind === 'refused') this.invalidateOnUnauthorized(command.workspaceId, outcome.code);
    return { ...outcome, attribution: this.attribution(r.credentials) };
  }

  async fetchCampaignMetrics(query: MetricsFetchQuery): Promise<MetricsFetchOutcome> {
    const r = await this.resolve({
      workspaceId: query.workspaceId,
      purpose: 'metrics',
      userId: query.userId,
      initiatedBy: query.initiatedBy ?? 'user',
    });
    if (!r.ok) return { kind: 'unconfigured', message: `Reddit connection is not ready (${r.code}): ${r.message}. No remote call was sent.` };
    const outcome = await this.delegate(r.credentials).fetchCampaignMetrics(query);
    if (outcome.kind === 'refused') this.invalidateOnUnauthorized(query.workspaceId, outcome.code);
    return { ...outcome, attribution: this.attribution(r.credentials) };
  }

  async syncAccountMapping(workspaceId: string) {
    if (this.source.kind !== 'broker') return undefined;
    const r = await this.resolve({ workspaceId, purpose: 'preflight', initiatedBy: 'system' });
    if (r.ok) return { accountId: r.credentials.accountId, connectionId: r.credentials.connectionId! };
    if (r.code === 'broker_unavailable') return undefined;
    return null;
  }
}
