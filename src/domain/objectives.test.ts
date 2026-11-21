import { describe, expect, it } from 'vitest';
import { resolveMetaObjective, resolveRedditObjective } from './objectives.js';

describe('H2-04 objective mapping with conversion signal verification', () => {
  it('maps verified conversion signals to CONVERSIONS / OUTCOME_LEADS and downgrades unverified signals to traffic', () => {
    expect(
      resolveRedditObjective({ objective: 'OUTCOME_LEADS', conversionSignalVerified: true })
    ).toBe('CONVERSIONS');
    expect(
      resolveRedditObjective({ objective: 'OUTCOME_LEADS', conversionSignalVerified: false })
    ).toBe('CLICKS');
    expect(resolveRedditObjective({ objective: 'OUTCOME_AWARENESS' })).toBe('IMPRESSIONS');

    expect(
      resolveMetaObjective({ objective: 'OUTCOME_LEADS', conversionSignalVerified: true })
    ).toBe('OUTCOME_LEADS');
    expect(
      resolveMetaObjective({ objective: 'OUTCOME_SALES', conversionSignalVerified: false })
    ).toBe('OUTCOME_TRAFFIC');
  });
});
