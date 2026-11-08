import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REDDIT_CALL_TO_ACTION } from '../../domain/creative.js';
import { REDDIT_GENDERS, REDDIT_LANGUAGES, REDDIT_LOCATIONS, REDDIT_PLATFORMS } from '../../domain/targeting.js';
import { toRedditStructuredPostData } from './structured-post.js';
import { FIXTURE_CREATIVE, FIXTURE_LANDING_PAGE_URL, FIXTURE_MEDIA_URL } from '../../testing/config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const contract = JSON.parse(
  readFileSync(join(root, 'tests/fixtures/reddit-ads-v3-official-contract.json'), 'utf8')
) as {
  sources: string[];
  paths: Record<string, { scope?: string; legacy?: boolean; supportedInThisSlice?: boolean }>;
  imageCreativeRequired: string[];
  textCreativeRequired: string[];
  mediaUrl: { typeConst: string };
  destinationUrl: { typeConst: string };
  callToAction: string[];
  platforms: string[];
  deprecatedPlatforms: string[];
  locations: string[];
  genders: string[];
  languages: string[];
  unsupportedInThisSlice: string[];
};

describe('Reddit Ads API v3 official contract pin [unit]', () => {
  it('cites official docs and OpenAPI, not invented hosts', () => {
    expect(contract.sources.every((url) => url.startsWith('https://ads-api.reddit.com/'))).toBe(true);
    expect(contract.paths['POST /profiles/{profile_id}/structured_posts/jobs']?.scope).toBe('adsedit');
    expect(contract.paths['GET /structured_posts/jobs/{post_creation_job_id}']?.scope).toBe('adsread');
    expect(contract.paths['POST /profiles/{profile_id}/posts']?.legacy).toBe(true);
    expect(contract.paths['POST /profiles/{profile_id}/creative_assets/uploads']?.supportedInThisSlice).toBe(false);
  });

  it('builds IMAGE job creative with official required keys and exact landing destination', () => {
    const data = toRedditStructuredPostData(FIXTURE_CREATIVE, FIXTURE_LANDING_PAGE_URL);
    const creative = data.creative as {
      type: string;
      headline: string;
      destination: { type: string; url: string };
      image: { media: { type: string; url: string } };
    };
    for (const key of contract.imageCreativeRequired) {
      expect(creative).toHaveProperty(key);
    }
    expect(creative.type).toBe('IMAGE');
    expect(creative.destination.type).toBe(contract.destinationUrl.typeConst);
    expect(creative.destination.url).toBe(FIXTURE_LANDING_PAGE_URL);
    expect(creative.image.media.type).toBe(contract.mediaUrl.typeConst);
    expect(creative.image.media.url).toBe(FIXTURE_MEDIA_URL);
    expect(data).not.toHaveProperty('allow_comments');
  });

  it('builds TEXT job creative with official required keys and does not invent destination', () => {
    const data = toRedditStructuredPostData(
      { type: 'TEXT', headline: 'Plain', body: 'Body copy', textFormat: 'PLAIN_TEXT' },
      FIXTURE_LANDING_PAGE_URL
    );
    const creative = data.creative as Record<string, unknown>;
    for (const key of contract.textCreativeRequired) {
      expect(creative).toHaveProperty(key);
    }
    expect(creative.type).toBe('TEXT');
    expect(creative.text_format).toBe('PLAIN_TEXT');
    expect(creative).not.toHaveProperty('destination');
  });

  it('pins official enums used by targeting validation', () => {
    expect(REDDIT_CALL_TO_ACTION).toEqual(contract.callToAction);
    expect(REDDIT_PLATFORMS).toEqual(contract.platforms.filter((p) => !contract.deprecatedPlatforms.includes(p)));
    expect(REDDIT_LOCATIONS).toEqual(contract.locations);
    expect(REDDIT_GENDERS).toEqual(contract.genders);
    expect(REDDIT_LANGUAGES).toEqual(contract.languages);
    expect(contract.unsupportedInThisSlice).toEqual(
      expect.arrayContaining(['VIDEO creative', 'legacy POST /profiles/{id}/posts', 'binary creative_assets/uploads'])
    );
  });
});
