import { describe, expect, it } from 'vitest';
import { RequestValidationError } from '../errors.js';
import { parseVerbArgs } from './verbs.js';
import {
  FIXTURE_LANDING_PAGE_URL,
  FIXTURE_PROVIDER_POST_ID,
  FIXTURE_RESEARCH_ACCEPTANCE,
} from '../testing/config.js';

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
    expect(() =>
      parseVerbArgs('ads.create_campaign', {
        name: 'n',
        landingPageUrl: FIXTURE_LANDING_PAGE_URL,
        dailyBudget: 1,
        currency: 'usd',
        platform: 'reddit',
      })
    ).toThrow(RequestValidationError);
    const parsed = parseVerbArgs('ads.create_campaign', {
      name: 'n',
      landingPageUrl: FIXTURE_LANDING_PAGE_URL,
      dailyBudget: 1,
      currency: 'usd',
      platform: 'reddit',
      providerPostId: FIXTURE_PROVIDER_POST_ID,
      researchAcceptance: FIXTURE_RESEARCH_ACCEPTANCE,
    });
    expect(parsed.landingPageUrl).toBe(FIXTURE_LANDING_PAGE_URL);
    expect(parsed.currency).toBe('USD');
    expect(parsed.providerPostId).toBe(FIXTURE_PROVIDER_POST_ID);
    expect(parsed.researchAcceptance).toEqual(FIXTURE_RESEARCH_ACCEPTANCE);
  });

  it('rejects a non-t3_ providerPostId instead of inventing a post', () => {
    expect(() =>
      parseVerbArgs('ads.create_campaign', {
        name: 'n',
        landingPageUrl: FIXTURE_LANDING_PAGE_URL,
        dailyBudget: 1,
        currency: 'USD',
        platform: 'reddit',
        providerPostId: 'not-a-post',
        researchAcceptance: FIXTURE_RESEARCH_ACCEPTANCE,
      })
    ).toThrow(RequestValidationError);
  });
});
