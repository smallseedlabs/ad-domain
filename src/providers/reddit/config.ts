export const REDDIT_ADS_API_BASE = 'https://ads-api.reddit.com/api/v3';
export const REDDIT_USER_AGENT = 'web:proba-ads:0.1.0 (internal Ads domain; no public user)';

/** Reddit Ads docs examples look like t2_/a2_/p2_. Spaces and empty values are invalid. */
const PIXEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,127}$/;

export interface RedditAdsConfig {
  enabled: true;
  adAccountId: string;
  accessToken: string;
  apiBaseUrl: string;
  timeoutMs: number;
  userAgent: string;
  conversionPixelId?: string;
}

export function redditConversionPixelId(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  return PIXEL_ID.test(value) ? value : undefined;
}

export function redditCreatePrerequisiteError(config: RedditAdsConfig): string | undefined {
  if (!redditConversionPixelId(config.conversionPixelId)) {
    return 'REDDIT_CONVERSION_PIXEL_ID is required before creating a Reddit campaign or ad group (required on all ad groups since 2026-07-13). No remote create was sent.';
  }
  return undefined;
}
