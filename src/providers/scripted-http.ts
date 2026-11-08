import { HttpTimeoutError, type HttpRequest, type HttpResponse, type HttpTransport } from './http.js';

export type ScriptedStep =
  | { status: number; body?: unknown; headers?: Record<string, string>; bodyText?: string }
  | { timeout: true }
  | { network: true; message?: string };

/**
 * Test-only transport. Replays scripted responses in order. Does not open sockets.
 */
export class ScriptedHttpTransport implements HttpTransport {
  readonly calls: HttpRequest[] = [];
  private cursor = 0;

  constructor(private readonly steps: ScriptedStep[]) {}

  async request(input: HttpRequest): Promise<HttpResponse> {
    this.calls.push(input);
    const step = this.steps[this.cursor++];
    if (!step) {
      throw new Error(`scripted HTTP: unexpected extra request ${input.method} ${input.url}`);
    }
    if ('timeout' in step && step.timeout) {
      throw new HttpTimeoutError(input.timeoutMs);
    }
    if ('network' in step && step.network) {
      throw new Error(step.message ?? 'scripted network failure');
    }
    if (!('status' in step)) {
      throw new Error('scripted HTTP: invalid step');
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(step.headers ?? {})) {
      headers[key.toLowerCase()] = value;
    }
    const bodyText =
      step.bodyText ?? (step.body === undefined ? '' : typeof step.body === 'string' ? step.body : JSON.stringify(step.body));
    return { status: step.status, headers, bodyText };
  }
}
