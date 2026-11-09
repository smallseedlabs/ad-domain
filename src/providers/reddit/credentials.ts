import { createPrivateKey, randomUUID, type KeyObject } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { SignJWT } from 'jose';
import { ConfigError } from '../../errors.js';
import type { ConnectionBrokerConfig } from '../../types/config.js';
import type { HttpTransport } from '../http.js';
import type { ActionInitiator } from '../port.js';

/**
 * Where the Reddit adapter gets its bearer token and account for a workspace.
 *   file:   one static token + REDDIT_AD_ACCOUNT_ID (local debugging fallback)
 *   broker: the Hub connection broker (per workspace, short-lived, attributed)
 */
export interface RedditCredentials {
  tokenSource: 'broker' | 'file';
  accessToken: string;
  accountId: string;
  connectionId?: string;
  connectedBy?: string;
}

export type CredentialFailureCode = 'not_connected' | 'account_not_selected' | 'needs_reconnect' | 'broker_unavailable' | 'broker_refused';

export type CredentialResult =
  | { ok: true; credentials: RedditCredentials }
  | { ok: false; code: CredentialFailureCode; message: string };

export interface CredentialRequest {
  workspaceId: string;
  purpose: 'mutate' | 'metrics' | 'preflight' | 'billing';
  userId?: string;
  initiatedBy?: ActionInitiator;
  traceId?: string;
}

export interface RedditCredentialSource {
  readonly kind: 'broker' | 'file';
  get(request: CredentialRequest): Promise<CredentialResult>;
}

export class StaticCredentialSource implements RedditCredentialSource {
  readonly kind = 'file' as const;
  constructor(private readonly credentials: { accessToken: string; accountId: string }) {}
  async get(): Promise<CredentialResult> {
    return { ok: true, credentials: { tokenSource: 'file', ...this.credentials } };
  }
}

export const ADS_SERVICE_ISSUER = 'proba-ads';
export const ADS_SERVICE_SUBJECT = 'ads';
export const BROKER_AUDIENCE = 'proba-hub';
const TOKEN_TTL_SECONDS = 60;
const REFRESH_MARGIN_MS = 60_000;
/** Cap on reuse of one brokered token, even if the provider token lives longer. */
const MAX_CACHE_MS = 10 * 60_000;

export function loadAdsServiceKey(file: string, production: boolean): KeyObject {
  try {
    const info = statSync(file);
    if (production && process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      throw new ConfigError(`ADS_SERVICE_PRIVATE_KEY_FILE ${file} is readable by group or others; chmod 600 it`);
    }
    const key = createPrivateKey(readFileSync(file, 'utf8'));
    if (key.asymmetricKeyType !== 'ed25519') throw new ConfigError('ADS_SERVICE_PRIVATE_KEY_FILE must hold an Ed25519 key');
    return key;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`ADS_SERVICE_PRIVATE_KEY_FILE cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
}

/**
 * Asks the Hub connection broker for a workspace's Reddit access token with an EdDSA
 * service token (iss proba-ads, aud proba-hub, sub ads, workspaceId, 60 s, single-use jti).
 * Tokens are cached per workspace until shortly before expiry. Fails closed.
 */
export class BrokerCredentialSource implements RedditCredentialSource {
  readonly kind = 'broker' as const;
  private readonly cache = new Map<string, { credentials: RedditCredentials; until: number }>();
  private readonly now: () => number;

  constructor(
    private readonly config: ConnectionBrokerConfig,
    private readonly key: KeyObject,
    private readonly transport: HttpTransport,
    options: { now?: () => number } = {}
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }

  async get(request: CredentialRequest): Promise<CredentialResult> {
    const hit = this.cache.get(request.workspaceId);
    if (hit && hit.until > this.now()) return { ok: true, credentials: hit.credentials };
    const iat = Math.floor(this.now() / 1000);
    const token = await new SignJWT({ workspaceId: request.workspaceId })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.config.keyId, typ: 'JWT' })
      .setIssuer(ADS_SERVICE_ISSUER)
      .setAudience(BROKER_AUDIENCE)
      .setSubject(ADS_SERVICE_SUBJECT)
      .setIssuedAt(iat)
      .setExpirationTime(iat + TOKEN_TTL_SECONDS)
      .setJti(randomUUID())
      .sign(this.key);
    let response;
    try {
      response = await this.transport.request({
        method: 'POST',
        url: `${this.config.url}/v1/internal/connections/reddit/access-token`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          workspaceId: request.workspaceId,
          purpose: request.purpose,
          ...(request.userId ? { userId: request.userId } : {}),
          initiatedBy: request.initiatedBy ?? 'user',
          ...(request.traceId ? { traceId: request.traceId } : {}),
        }),
        timeoutMs: this.config.timeoutMs,
      });
    } catch {
      return { ok: false, code: 'broker_unavailable', message: 'the connection broker is unreachable' };
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(response.bodyText || '{}') as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (response.status === 200) {
      const accessToken = typeof body.accessToken === 'string' ? body.accessToken : '';
      const accountId = typeof body.accountId === 'string' ? body.accountId : '';
      const connectionId = typeof body.connectionId === 'string' ? body.connectionId : '';
      const expiresAt = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN;
      if (!accessToken || !accountId || !connectionId || !Number.isFinite(expiresAt)) {
        return { ok: false, code: 'broker_refused', message: 'the connection broker returned an incomplete credential' };
      }
      const credentials: RedditCredentials = {
        tokenSource: 'broker',
        accessToken,
        accountId,
        connectionId,
        ...(typeof body.connectedBy === 'string' ? { connectedBy: body.connectedBy } : {}),
      };
      const until = Math.min(expiresAt - REFRESH_MARGIN_MS, this.now() + MAX_CACHE_MS);
      if (until > this.now()) this.cache.set(request.workspaceId, { credentials, until });
      return { ok: true, credentials };
    }
    this.cache.delete(request.workspaceId);
    const code = typeof body.error === 'string' ? body.error : '';
    if (code === 'not_connected' || code === 'account_not_selected' || code === 'needs_reconnect') {
      return { ok: false, code, message: typeof body.message === 'string' ? body.message : code };
    }
    if (response.status >= 500 || response.status === 429) {
      return { ok: false, code: 'broker_unavailable', message: `the connection broker answered ${response.status}` };
    }
    return { ok: false, code: 'broker_refused', message: `the connection broker refused the request (${code || response.status})` };
  }
}
