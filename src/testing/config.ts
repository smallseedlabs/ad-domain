import { loadConfig } from '../config.js';
import type { AdsServiceConfig } from '../types/config.js';

export function testConfig(env: NodeJS.ProcessEnv = {}): AdsServiceConfig {
  return loadConfig({
    NODE_ENV: 'test',
    AUDIT_PUBLISHER: 'log',
    ADS_ALLOW_TEST_FAKES: 'true',
    ...env,
  });
}

/** Request-arg fixture only. Not a product default and not a user-entered URL. */
export const FIXTURE_LANDING_PAGE_URL = 'https://example.test/offer';

export const FIXTURE_USER_ID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_TRACE_ID = '22222222-2222-4222-8222-222222222222';
export const FIXTURE_WORKSPACE = 'workspace-test';
