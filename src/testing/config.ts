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
/** Official-shaped Reddit post id. Used when tests exercise the existing-post path. */
export const FIXTURE_PROVIDER_POST_ID = 't3_testpost';
export const FIXTURE_PROVIDER_PROFILE_ID = 't2_testprofile';
/** Official MediaUrl type=URL fixture. Not a product default. */
export const FIXTURE_MEDIA_URL = 'https://example.test/creative.jpg';
export const FIXTURE_HEADLINE = 'Test offer';
/** Protocol researchAcceptance binding fixture. Ads does not call Hub to prove stored acceptance. */
export const FIXTURE_RESEARCH_ACCEPTANCE = {
  artifactId: '33333333-3333-4333-8333-333333333333',
  version: 1,
  inputRevision: 'rev-1',
} as const;

export const FIXTURE_CREATIVE = {
  type: 'IMAGE' as const,
  headline: FIXTURE_HEADLINE,
  mediaUrl: FIXTURE_MEDIA_URL,
  callToAction: 'Learn More' as const,
};

export function fixtureCreateArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const args: Record<string, unknown> = {
    name: 'test campaign',
    landingPageUrl: FIXTURE_LANDING_PAGE_URL,
    dailyBudget: 12,
    currency: 'USD',
    platform: 'reddit',
    creative: { ...FIXTURE_CREATIVE },
    researchAcceptance: { ...FIXTURE_RESEARCH_ACCEPTANCE },
    ...extra,
  };
  if (typeof extra.providerPostId === 'string' && extra.creative === undefined) {
    delete args.creative;
  }
  return args;
}
