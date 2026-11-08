import { describe, expect, it } from 'vitest';
import { RequestValidationError } from '../errors.js';
import { parseVerbArgs } from './verbs.js';
import { FIXTURE_LANDING_PAGE_URL } from '../testing/config.js';

describe('verb args [unit]', () => {
  it('requires a caller-supplied landingPageUrl on create and does not substitute one', () => {
    expect(() =>
      parseVerbArgs('ads.create_campaign', {
        name: 'n',
        dailyBudget: 1,
        currency: 'USD',
        platform: 'reddit',
      })
    ).toThrow(RequestValidationError);
    const parsed = parseVerbArgs('ads.create_campaign', {
      name: 'n',
      landingPageUrl: FIXTURE_LANDING_PAGE_URL,
      dailyBudget: 1,
      currency: 'usd',
      platform: 'reddit',
    });
    expect(parsed.landingPageUrl).toBe(FIXTURE_LANDING_PAGE_URL);
    expect(parsed.currency).toBe('USD');
  });
});
