import { HttpTimeoutError, httpAuditSafe, type HttpTransport } from '../http.js';
import type { RedditAdsConfig } from './config.js';

export type RedditHttpKind = 'ok' | 'refused' | 'unauthorized' | 'not_found' | 'rate_limited' | 'timeout' | 'ambiguous' | 'unavailable';

export interface RedditHttpResult<T> {
  kind: RedditHttpKind;
  status?: number;
  data?: T;
  raw?: unknown;
  message: string;
  audit: Record<string, unknown>;
}

function headerBag(token: string, userAgent: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'user-agent': userAgent,
  };
  if (hasBody) headers['content-type'] = 'application/json';
  return headers;
}

function parseJson(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { _unparsed: true };
  }
}

function redditMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const err = (body as { error?: { message?: unknown } }).error;
  if (err && typeof err.message === 'string' && err.message.trim()) return err.message;
  const message = (body as { message?: unknown }).message;
  if (typeof message === 'string' && message.trim()) return message;
  return fallback;
}

function envelopeData(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in body) return (body as { data: unknown }).data;
  return body;
}

export class RedditAdsClient {
  constructor(
    private readonly config: RedditAdsConfig,
    private readonly transport: HttpTransport
  ) {}

  private url(path: string): string {
    return `${this.config.apiBaseUrl.replace(/\/$/, '')}${path}`;
  }

  private async send<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    options?: { mutation?: boolean; absoluteUrl?: string }
  ): Promise<RedditHttpResult<T>> {
    const mutation = options?.mutation ?? method !== 'GET';
    const request = {
      method,
      url: options?.absoluteUrl ?? this.url(path),
      headers: headerBag(this.config.accessToken, this.config.userAgent, body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: this.config.timeoutMs,
    };
    try {
      const response = await this.transport.request(request);
      const audit = httpAuditSafe(request, response);
      const parsed = parseJson(response.bodyText);
      if (response.status === 401) {
        return { kind: 'unauthorized', status: 401, message: redditMessage(parsed, 'Reddit bearer token was rejected'), audit };
      }
      if (response.status === 403) {
        return { kind: 'unauthorized', status: 403, message: redditMessage(parsed, 'Reddit denied the requested scope or resource'), audit };
      }
      if (response.status === 404) {
        return { kind: 'not_found', status: 404, message: redditMessage(parsed, 'Reddit resource was not found'), audit };
      }
      if (response.status === 429) {
        return {
          kind: 'rate_limited',
          status: 429,
          message: redditMessage(parsed, mutation ? 'Reddit rate limit exceeded; mutation was not retried' : 'Reddit rate limit exceeded; report was not retried'),
          audit,
        };
      }
      if (response.status >= 500) {
        return {
          kind: mutation ? 'ambiguous' : 'unavailable',
          status: response.status,
          message: redditMessage(parsed, `Reddit returned HTTP ${response.status}`),
          audit,
        };
      }
      if (response.status >= 400) {
        return { kind: 'refused', status: response.status, message: redditMessage(parsed, `Reddit refused the request (${response.status})`), audit };
      }
      if ((parsed as { _unparsed?: boolean })._unparsed) {
        return {
          kind: mutation ? 'ambiguous' : 'unavailable',
          status: response.status,
          message: 'Reddit response was not JSON; outcome is not claimed',
          audit,
        };
      }
      return { kind: 'ok', status: response.status, data: envelopeData(parsed) as T, raw: parsed, message: 'ok', audit };
    } catch (err) {
      const audit = httpAuditSafe(request);
      if (err instanceof HttpTimeoutError) {
        return {
          kind: mutation ? 'ambiguous' : 'timeout',
          message: err.message,
          audit,
        };
      }
      return {
        kind: mutation ? 'ambiguous' : 'unavailable',
        message: err instanceof Error ? err.message : 'provider HTTP failed',
        audit,
      };
    }
  }

  getAdAccount(adAccountId: string) {
    return this.send<Record<string, unknown>>('GET', `/ad_accounts/${encodeURIComponent(adAccountId)}`);
  }

  listFundingInstruments(adAccountId: string) {
    return this.send<unknown>(
      'GET',
      `/ad_accounts/${encodeURIComponent(adAccountId)}/funding_instruments?mode=SELECTABLE`
    );
  }

  getCampaign(campaignId: string) {
    return this.send<Record<string, unknown>>('GET', `/campaigns/${encodeURIComponent(campaignId)}`);
  }

  createCampaign(adAccountId: string, data: Record<string, unknown>) {
    return this.send<Record<string, unknown>>('POST', `/ad_accounts/${encodeURIComponent(adAccountId)}/campaigns`, { data });
  }

  updateCampaign(campaignId: string, data: Record<string, unknown>) {
    return this.send<Record<string, unknown>>('PATCH', `/campaigns/${encodeURIComponent(campaignId)}`, { data });
  }

  createAdGroup(adAccountId: string, data: Record<string, unknown>) {
    return this.send<Record<string, unknown>>('POST', `/ad_accounts/${encodeURIComponent(adAccountId)}/ad_groups`, { data });
  }

  updateAdGroup(adGroupId: string, data: Record<string, unknown>) {
    return this.send<Record<string, unknown>>('PATCH', `/ad_groups/${encodeURIComponent(adGroupId)}`, { data });
  }

  /**
   * Official read-only Get a Report. POST is the documented method; this is not a campaign mutation.
   * Timeouts/5xx are unavailable, not ambiguous campaign outcomes.
   */
  createReport(adAccountId: string, data: Record<string, unknown>, pageSize: number) {
    return this.send<unknown>(
      'POST',
      `/ad_accounts/${encodeURIComponent(adAccountId)}/reports?page.size=${pageSize}`,
      { data },
      { mutation: false }
    );
  }

  followReportUrl(absoluteUrl: string) {
    return this.send<unknown>('GET', '/', undefined, { mutation: false, absoluteUrl });
  }
}
