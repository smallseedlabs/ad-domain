import { describe, expect, it } from 'vitest';
import { RequestValidationError } from '../errors.js';
import { parseVerbArgs } from './verbs.js';
import {
  FIXTURE_CREATIVE,
  FIXTURE_LANDING_PAGE_URL,
  FIXTURE_MEDIA_URL,
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
        researchAcceptance: FIXTURE_RESEARCH_ACCEPTANCE,
      })
    ).toThrow(RequestValidationError);
    const parsed = parseVerbArgs('ads.create_campaign', {
      name: 'n',
      landingPageUrl: FIXTURE_LANDING_PAGE_URL,
      dailyBudget: 1,
      currency: 'usd',
      platform: 'reddit',
      creative: FIXTURE_CREATIVE,
      researchAcceptance: FIXTURE_RESEARCH_ACCEPTANCE,
    });
    expect(parsed.landingPageUrl).toBe(FIXTURE_LANDING_PAGE_URL);
    expect(parsed.currency).toBe('USD');
    expect(parsed.creative).toMatchObject({ type: 'IMAGE', mediaUrl: FIXTURE_MEDIA_URL });
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

  it('rejects supplying both creative and providerPostId', () => {
    expect(() =>
      parseVerbArgs('ads.create_campaign', {
        name: 'n',
        landingPageUrl: FIXTURE_LANDING_PAGE_URL,
        dailyBudget: 1,
        currency: 'USD',
        platform: 'reddit',
        providerPostId: FIXTURE_PROVIDER_POST_ID,
        creative: FIXTURE_CREATIVE,
        researchAcceptance: FIXTURE_RESEARCH_ACCEPTANCE,
      })
    ).toThrow(RequestValidationError);
  });

  it('fails closed on VIDEO creative instead of inventing a payload', () => {
    expect(() =>
      parseVerbArgs('ads.create_campaign', {
        name: 'n',
        landingPageUrl: FIXTURE_LANDING_PAGE_URL,
        dailyBudget: 1,
        currency: 'USD',
        platform: 'reddit',
        creative: { type: 'VIDEO', headline: 'x', mediaUrl: FIXTURE_MEDIA_URL },
        researchAcceptance: FIXTURE_RESEARCH_ACCEPTANCE,
      })
    ).toThrow(/VIDEO/);
  });

  it('rejects t5_ community ids and deprecated DESKTOP_LEGACY', () => {
    expect(() =>
      parseVerbArgs('ads.create_campaign', {
        name: 'n',
        landingPageUrl: FIXTURE_LANDING_PAGE_URL,
        dailyBudget: 1,
        currency: 'USD',
        platform: 'reddit',
        creative: FIXTURE_CREATIVE,
        targeting: { communities: ['t5_abc'] },
        researchAcceptance: FIXTURE_RESEARCH_ACCEPTANCE,
      })
    ).toThrow(/subreddit names/);
    expect(() =>
      parseVerbArgs('ads.create_campaign', {
        name: 'n',
        landingPageUrl: FIXTURE_LANDING_PAGE_URL,
        dailyBudget: 1,
        currency: 'USD',
        platform: 'reddit',
        creative: FIXTURE_CREATIVE,
        targeting: { platforms: ['DESKTOP_LEGACY'] },
        researchAcceptance: FIXTURE_RESEARCH_ACCEPTANCE,
      })
    ).toThrow(/DESKTOP_LEGACY/);
  });
});
