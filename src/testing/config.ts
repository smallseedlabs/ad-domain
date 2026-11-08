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
export const FIXTURE_GOAL_ID = '44444444-4444-4444-8444-444444444444';
/** Official-shaped Reddit post id used as ad creative. Not created by this process. */
export const FIXTURE_PROVIDER_POST_ID = 't3_testpost';
/** Protocol researchAcceptance binding fixture. Ads does not call Hub to prove stored acceptance. */
export const FIXTURE_RESEARCH_ACCEPTANCE = {
  artifactId: '33333333-3333-4333-8333-333333333333',
  version: 1,
  inputRevision: 'rev-1',
} as const;

export function fixtureCreateArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'test campaign',
    landingPageUrl: FIXTURE_LANDING_PAGE_URL,
    dailyBudget: 12,
    currency: 'USD',
    platform: 'reddit',
    providerPostId: FIXTURE_PROVIDER_POST_ID,
    researchAcceptance: { ...FIXTURE_RESEARCH_ACCEPTANCE },
    ...extra,
  };
}
