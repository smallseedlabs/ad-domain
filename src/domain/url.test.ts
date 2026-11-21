import { describe, expect, it } from 'vitest';
import { RequestValidationError } from '../errors.js';
import { appendUtmParams, assertLandingPageUrl } from './url.js';
import { FIXTURE_LANDING_PAGE_URL } from '../testing/config.js';

describe('landingPageUrl request validation [unit]', () => {
  it('preserves the exact caller-supplied URL and has no default', () => {
    expect(assertLandingPageUrl(FIXTURE_LANDING_PAGE_URL)).toBe(FIXTURE_LANDING_PAGE_URL);
  });

  it('rejects missing, relative, credentialed, and non-http URLs', () => {
    expect(() => assertLandingPageUrl(undefined)).toThrow(RequestValidationError);
    expect(() => assertLandingPageUrl('')).toThrow(RequestValidationError);
    expect(() => assertLandingPageUrl('/local')).toThrow(RequestValidationError);
    expect(() => assertLandingPageUrl('https://user:pass@example.test/x')).toThrow(RequestValidationError);
    expect(() => assertLandingPageUrl('ftp://example.test/x')).toThrow(RequestValidationError);
  });

  it('H2-05: appends utm_source/campaign/content while preserving path, query, and hash', () => {
    const out = appendUtmParams('https://acme.example/demo/signup?ref=launch&plan=pro#form', {
      platform: 'reddit',
      goalId: 'goal-42',
      cellId: 'cell-a',
    });
    const parsed = new URL(out);
    expect(parsed.origin).toBe('https://acme.example');
    expect(parsed.pathname).toBe('/demo/signup');
    expect(parsed.hash).toBe('#form');
    expect(parsed.searchParams.get('ref')).toBe('launch');
    expect(parsed.searchParams.get('plan')).toBe('pro');
    expect(parsed.searchParams.get('utm_source')).toBe('reddit');
    expect(parsed.searchParams.get('utm_medium')).toBe('paid_social');
    expect(parsed.searchParams.get('utm_campaign')).toBe('goal-42');
    expect(parsed.searchParams.get('utm_content')).toBe('cell-a');
  });
});
