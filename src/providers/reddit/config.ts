export const REDDIT_ADS_API_BASE = 'https://ads-api.reddit.com/api/v3';
export const REDDIT_USER_AGENT = 'web:proba-ads:0.1.0 (internal Ads domain; no public user)';

export interface RedditAdsConfig {
  enabled: true;
  adAccountId: string;
  accessToken: string;
  apiBaseUrl: string;
  timeoutMs: number;
  userAgent: string;
  conversionPixelId?: string;
}
