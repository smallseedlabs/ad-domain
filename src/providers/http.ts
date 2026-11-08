import { maskSecretsInText } from '../redact.js';

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

export interface HttpTransport {
  request(input: HttpRequest): Promise<HttpResponse>;
}

export class HttpTimeoutError extends Error {
  readonly name = 'HttpTimeoutError';
  constructor(readonly timeoutMs: number) {
    super(`provider HTTP request timed out after ${timeoutMs}ms`);
  }
}

export class FetchHttpTransport implements HttpTransport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async request(input: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const res = await this.fetchImpl(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        signal: controller.signal,
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: res.status, headers, bodyText: await res.text() };
    } catch (err) {
      if (controller.signal.aborted) throw new HttpTimeoutError(input.timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Safe summary for logs/audit. Never includes Authorization or raw bodies. */
export function httpAuditSafe(request: HttpRequest, response?: HttpResponse): Record<string, unknown> {
  let path = request.url;
  try {
    const parsed = new URL(request.url);
    path = `${parsed.origin}${parsed.pathname}`;
  } catch {
    path = maskSecretsInText(request.url).text;
  }
  return {
    method: request.method,
    url: path,
    status: response?.status,
    rateLimit: response?.headers['ratelimit'],
  };
}
