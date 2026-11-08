import type { MetricObservation, MetricValues } from '../../protocol.js';
import { validateMetricObservation } from '../../protocol.js';
import type { QuarantinedMetricRow } from '../metrics.js';
import { fromMicros } from './money.js';
import { addUtcDays, addUtcHours, toUtcMillis, utcDayStart } from './time.js';

export interface RedditReportPage {
  metrics: Record<string, unknown>[];
  nextUrl?: string;
}

export interface NormalizeContext {
  accountId: string;
  expectedCampaignId: string;
  granularity: 'hour' | 'day';
  timezone: string;
  fetchedAt: string;
}

export interface NormalizedReport {
  observations: MetricObservation[];
  quarantined: QuarantinedMetricRow[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function field(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (row[name] !== undefined) return row[name];
    const lower = name.toLowerCase();
    if (row[lower] !== undefined) return row[lower];
  }
  return undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseRedditReportPage(raw: unknown, data: unknown): RedditReportPage {
  const payload = asRecord(data);
  const rowsSource = Array.isArray(data)
    ? data
    : Array.isArray(payload?.metrics)
      ? payload.metrics
      : [];
  const metrics = rowsSource.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
  const pagination = asRecord(raw)?.pagination;
  const nextUrl = asRecord(pagination)?.next_url;
  return {
    metrics,
    nextUrl: typeof nextUrl === 'string' && nextUrl.length > 0 ? nextUrl : undefined,
  };
}

function periodFromRow(
  row: Record<string, unknown>,
  granularity: 'hour' | 'day'
): { start: string; end: string; label: string } | { reason: string } {
  if (granularity === 'day') {
    const date = asString(field(row, 'DATE', 'date'));
    if (!date) return { reason: 'Reddit DATE was missing; day period bounds were not invented' };
    try {
      const start = utcDayStart(date.slice(0, 10));
      return { start, end: addUtcDays(start, 1), label: date.slice(0, 10) };
    } catch {
      return { reason: `Reddit DATE "${date}" is not YYYY-MM-DD; period bounds were not invented` };
    }
  }
  const datetime = asString(field(row, 'DATETIME', 'datetime', 'HOUR', 'hour'));
  if (!datetime) return { reason: 'Reddit DATETIME/HOUR was missing; hour period bounds were not invented' };
  try {
    const start = toUtcMillis(datetime.endsWith('Z') ? datetime : `${datetime}Z`);
    return { start, end: addUtcHours(start, 1), label: start };
  } catch {
    return { reason: `Reddit DATETIME/HOUR "${datetime}" is not a usable timestamp; period bounds were not invented` };
  }
}

function quarantine(reason: string, row: Record<string, unknown>, period?: string): QuarantinedMetricRow {
  const campaignId = asString(field(row, 'CAMPAIGN_ID', 'campaign_id'));
  return { reason, campaignId, period, fields: Object.keys(row).slice(0, 20) };
}

/**
 * Map Reddit report rows to protocol MetricObservation.
 * Missing required protocol metrics stay absent (quarantined). Never coerced to 0.
 */
export function normalizeRedditMetrics(rows: Record<string, unknown>[], ctx: NormalizeContext): NormalizedReport {
  const observations: MetricObservation[] = [];
  const quarantined: QuarantinedMetricRow[] = [];

  for (const row of rows) {
    const campaignId = asString(field(row, 'CAMPAIGN_ID', 'campaign_id'));
    if (!campaignId) {
      quarantined.push(quarantine('Reddit campaign_id was missing; row was not attributed', row));
      continue;
    }
    if (campaignId !== ctx.expectedCampaignId) {
      quarantined.push(
        quarantine(
          `Reddit campaign_id ${campaignId} does not match the mapped campaign ${ctx.expectedCampaignId}; row was not attributed`,
          row
        )
      );
      continue;
    }

    const period = periodFromRow(row, ctx.granularity);
    if ('reason' in period) {
      quarantined.push(quarantine(period.reason, row));
      continue;
    }

    const impressions = asFiniteNumber(field(row, 'IMPRESSIONS', 'impressions'));
    const clicks = asFiniteNumber(field(row, 'CLICKS', 'clicks'));
    const spendMicros = asFiniteNumber(field(row, 'SPEND', 'spend'));
    const conversions = asFiniteNumber(field(row, 'KEY_CONVERSION_TOTAL_COUNT', 'key_conversion_total_count'));
    const currency = asString(field(row, 'CURRENCY', 'currency'))?.toUpperCase();
    const missing: string[] = [];
    if (impressions === undefined) missing.push('impressions');
    if (clicks === undefined) missing.push('clicks');
    if (spendMicros === undefined) missing.push('spend');
    if (conversions === undefined) missing.push('conversions');
    if (!currency || currency.length !== 3) missing.push('currency');
    if (
      missing.length > 0 ||
      impressions === undefined ||
      clicks === undefined ||
      spendMicros === undefined ||
      conversions === undefined ||
      !currency
    ) {
      const conversionNote = missing.includes('conversions')
        ? ' Protocol MetricValues.conversions is required; Reddit KEY_CONVERSION_TOTAL_COUNT was null/absent and was not fabricated as 0.'
        : '';
      quarantined.push(
        quarantine(
          `Reddit row missing protocol-required metric(s): ${missing.join(', ')}.${conversionNote} Missing values stay absent, never 0.`,
          row,
          period.label
        )
      );
      continue;
    }
    if (!Number.isInteger(impressions) || impressions < 0 || !Number.isInteger(clicks) || clicks < 0 || spendMicros < 0 || conversions < 0) {
      quarantined.push(quarantine('Reddit metric was negative or impressions/clicks were not integers; row was not coerced', row, period.label));
      continue;
    }

    const metrics: MetricValues = {
      impressions,
      clicks,
      spend: fromMicros(spendMicros),
      conversions,
    };
    const reach = asFiniteNumber(field(row, 'REACH', 'reach'));
    if (reach !== undefined && Number.isInteger(reach) && reach >= 0) metrics.reach = reach;
    const videoViews = asFiniteNumber(field(row, 'VIDEO_VIEWABLE_IMPRESSIONS', 'video_viewable_impressions'));
    if (videoViews !== undefined && Number.isInteger(videoViews) && videoViews >= 0) metrics.videoViews = videoViews;

    const candidate: MetricObservation = {
      version: 1,
      platform: 'reddit',
      accountId: ctx.accountId,
      campaignId,
      granularity: ctx.granularity,
      periodStart: period.start,
      periodEnd: period.end,
      metrics,
      currency,
      fetchedAt: ctx.fetchedAt,
      timezone: ctx.timezone,
      revision: 0,
      sourceRef: `reddit:report:${ctx.accountId}:${campaignId}:${period.start}`,
    };
    const parsed = validateMetricObservation(candidate);
    if (!parsed.success) {
      quarantined.push(
        quarantine(
          `protocol validateMetricObservation refused the mapped row: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
          row,
          period.label
        )
      );
      continue;
    }
    observations.push(parsed.data);
  }

  return { observations, quarantined };
}
