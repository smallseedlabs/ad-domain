import type { MetricObservation } from '../protocol.js';

export const METRICS_FETCH_VERB = 'ads.fetch_metrics';

export interface MetricsFetchQuery {
  workspaceId: string;
  userId: string;
  probaCampaignId: string;
  providerAccountId: string;
  providerCampaignId: string;
  periodStart: string;
  periodEnd: string;
  granularity: 'hour' | 'day';
  timezone: string;
  fetchedAt: string;
  reportMaxPages: number;
  initiatedBy?: import('./port.js').ActionInitiator;
}

export interface QuarantinedMetricRow {
  reason: string;
  campaignId?: string;
  period?: string;
  fields?: string[];
}

export type MetricsFetchOutcome = (
  | {
      kind: 'ok';
      observations: MetricObservation[];
      quarantined: QuarantinedMetricRow[];
      pages: number;
    }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'unconfigured'; message: string }
) & { attribution?: import('./port.js').ProviderAttribution };
