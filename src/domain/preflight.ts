import type { Clock } from '../ports/clock.js';
import type { ProviderAdapter } from '../providers/port.js';
import type { AdsStore } from '../store/port.js';
import type { AdsServiceConfig } from '../types/config.js';
import type { PreflightRequest } from '../types/http.js';
import type { AdsPreflightReport } from '../types/preflight.js';
import { canonicalVerb } from './verbs.js';

export async function buildPreflightReport(input: {
  config: AdsServiceConfig;
  store: AdsStore;
  provider: ProviderAdapter;
  clock: Clock;
  query: PreflightRequest;
}): Promise<AdsPreflightReport> {
  const asOf = input.clock.isoNow();
  const freshUntil = new Date(input.clock.now().getTime() + input.config.ads.preflightFreshnessMs).toISOString();
  const platform = input.query.platform;
  const connection = await input.provider.connectionState(input.query.workspaceId, platform);
  const permissions = await input.provider.permissionState(input.query.workspaceId, platform);
  const billing = await input.provider.billingClaim(input.query.workspaceId, platform);

  const verb = input.query.verb ? canonicalVerb(input.query.verb) : undefined;
  const mappingRequired = input.query.mappingRequired || (verb !== undefined && verb !== 'ads.create_campaign');

  let blueprint: AdsPreflightReport['blueprint'];
  if (!mappingRequired && !input.query.probaCampaignId) {
    blueprint = { state: 'not_required', message: 'create does not require an existing Proba campaign mapping' };
  } else if (!input.query.probaCampaignId) {
    blueprint = { state: 'missing', message: 'probaCampaignId is required for this operation' };
  } else {
    const campaign = await input.store.withTransaction((tx) => tx.getCampaign(input.query.workspaceId, input.query.probaCampaignId!));
    if (!campaign) {
      blueprint = {
        state: 'missing',
        probaCampaignId: input.query.probaCampaignId,
        mapped: false,
        message: 'no campaign with this probaCampaignId in the caller workspace',
      };
    } else {
      blueprint = {
        state: campaign.providerCampaignId ? 'ready' : 'missing',
        probaCampaignId: campaign.probaCampaignId,
        mapped: Boolean(campaign.providerCampaignId),
        running: campaign.status === 'active',
        message: campaign.providerCampaignId
          ? 'campaign blueprint is mapped in this workspace'
          : 'campaign exists in this workspace but is not mapped to a provider resource',
      };
    }
  }

  return {
    asOf,
    freshUntil,
    service: { state: 'ready', message: 'Ads domain process is up; /ready is not a billing claim' },
    connection: {
      state: connection.state,
      platform: connection.platform,
      message: connection.message,
    },
    permissions: {
      state: permissions.state,
      actions: permissions.actions,
      message: permissions.message,
    },
    blueprint,
    billing,
  };
}
