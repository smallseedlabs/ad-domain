import { describe, expect, it } from 'vitest';
import { RequestValidationError } from '../errors.js';
import { assertLandingPageUrl } from './url.js';
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
});
