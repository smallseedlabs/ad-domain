import { RequestValidationError } from '../errors.js';

const MAX_LANDING_PAGE_URL = 2048;

/**
 * Syntactic checks on request-arg `landingPageUrl`. This does not prove the
 * value was entered by a user in Hub/web/portal (that wiring is absent
 * upstream). There is no default, fallback, or business-specific destination.
 * The original string is preserved.
 */
export function assertLandingPageUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestValidationError('landingPageUrl is required and must be supplied on the request');
  }
  const raw = value;
  if (raw.length > MAX_LANDING_PAGE_URL) {
    throw new RequestValidationError('landingPageUrl is too long');
  }
  if (raw !== raw.trim()) {
    throw new RequestValidationError('landingPageUrl must not include leading or trailing whitespace');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RequestValidationError('landingPageUrl is not a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RequestValidationError('landingPageUrl must be http or https');
  }
  if (parsed.username || parsed.password) {
    throw new RequestValidationError('landingPageUrl must not include credentials');
  }
  if (!parsed.hostname) {
    throw new RequestValidationError('landingPageUrl must include a hostname');
  }
  return raw;
}
