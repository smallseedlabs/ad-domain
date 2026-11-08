import { describe, expect, it } from 'vitest';
import { evaluateBillingGate } from './billing.js';
import { testConfig } from '../testing/config.js';
import { eligibleBillingClaim } from '../providers/fake.js';

describe('billing gate [unit]', () => {
  it('skips ad-balance for pause and still refuses spend-increase when billing is unknown', () => {
    const config = testConfig();
    const unknown = { kind: 'unknown' as const, reason: 'unconfigured adapters' };
    expect(evaluateBillingGate({ claim: unknown, spendClass: 'safety_decrease', config }).ok).toBe(true);
    expect(evaluateBillingGate({ claim: unknown, spendClass: 'spend_increase', dailyBudget: 10, currency: 'USD', config }).ok).toBe(
      false
    );
  });

  it('does not invent a $2 cap; optional cap applies only when configured', () => {
    const unset = testConfig();
    expect(unset.ads.maxDailyBudget).toBeNull();
    const allowed = evaluateBillingGate({
      claim: eligibleBillingClaim(),
      spendClass: 'spend_increase',
      dailyBudget: 500,
      currency: 'USD',
      config: unset,
    });
    expect(allowed.ok).toBe(true);
    const capped = testConfig({ ADS_MAX_DAILY_BUDGET: '25' });
    const blocked = evaluateBillingGate({
      claim: eligibleBillingClaim(),
      spendClass: 'spend_increase',
      dailyBudget: 40,
      currency: 'USD',
      config: capped,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe('budget_cap');
  });
});
