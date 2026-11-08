import { describe, expect, it } from 'vitest';
import { fromMicros } from './money.js';
import { normalizeRedditMetrics, parseRedditReportPage } from './normalize-metrics.js';

const CTX = {
  accountId: 'a2_testaccount',
  expectedCampaignId: 'cmp_1',
  granularity: 'day' as const,
  timezone: 'UTC',
  fetchedAt: '2026-11-08T12:00:00.000Z',
};

describe('normalizeRedditMetrics [unit]', () => {
  it('maps source-backed rows and divides SPEND micros; does not invent zeros', () => {
    const { observations, quarantined } = normalizeRedditMetrics(
      [
        {
          campaign_id: 'cmp_1',
          DATE: '2026-11-01',
          IMPRESSIONS: 50,
          CLICKS: 2,
          SPEND: 1_500_000,
          CURRENCY: 'USD',
          KEY_CONVERSION_TOTAL_COUNT: 1,
          REACH: 40,
        },
      ],
      CTX
    );
    expect(quarantined).toHaveLength(0);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.metrics).toEqual({
      impressions: 50,
      clicks: 2,
      spend: fromMicros(1_500_000),
      conversions: 1,
      reach: 40,
    });
    expect(observations[0]?.periodStart).toBe('2026-11-01T00:00:00.000Z');
    expect(observations[0]?.periodEnd).toBe('2026-11-02T00:00:00.000Z');
    expect(observations[0]?.sourceRef).toContain('reddit:report:');
  });

  it('quarantines null conversions instead of storing 0', () => {
    const { observations, quarantined } = normalizeRedditMetrics(
      [
        {
          campaign_id: 'cmp_1',
          DATE: '2026-11-01',
          IMPRESSIONS: 10,
          CLICKS: 1,
          SPEND: 0,
          CURRENCY: 'USD',
          KEY_CONVERSION_TOTAL_COUNT: null,
        },
      ],
      CTX
    );
    expect(observations).toHaveLength(0);
    expect(quarantined[0]?.reason).toMatch(/conversions/i);
    expect(quarantined[0]?.reason).toMatch(/not fabricated as 0/);
  });

  it('quarantines a row for a different campaign_id', () => {
    const { observations, quarantined } = normalizeRedditMetrics(
      [
        {
          campaign_id: 'cmp_other',
          DATE: '2026-11-01',
          IMPRESSIONS: 1,
          CLICKS: 0,
          SPEND: 0,
          CURRENCY: 'USD',
          KEY_CONVERSION_TOTAL_COUNT: 0,
        },
      ],
      CTX
    );
    expect(observations).toHaveLength(0);
    expect(quarantined[0]?.reason).toMatch(/does not match the mapped campaign/);
  });

  it('parses metrics from data.metrics plus pagination.next_url', () => {
    const page = parseRedditReportPage(
      {
        data: { metrics: [{ campaign_id: 'cmp_1' }] },
        pagination: { next_url: 'https://ads-api.reddit.com/api/v3?page.token=n' },
      },
      { metrics: [{ campaign_id: 'cmp_1' }] }
    );
    expect(page.metrics).toHaveLength(1);
    expect(page.nextUrl).toContain('page.token=n');
  });
});
