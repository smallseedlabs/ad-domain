import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { ScriptedHttpTransport } from '../scripted-http.js';
import { BrokerCredentialSource, StaticCredentialSource } from './credentials.js';

const WS = 'seedbed';
const USER = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const BROKER = { url: 'http://hub:3000', allowedHosts: ['hub:3000'], privateKeyFile: '/unused', keyId: 'ads-svc-1', timeoutMs: 1_000 };

function keys() {
  return generateKeyPairSync('ed25519');
}

function granted(expiresAt: string) {
  return {
    status: 200,
    body: {
      connectionId: CONNECTION,
      provider: 'reddit',
      accountId: 'a2_connected',
      accessToken: 'brokered-test-token',
      expiresAt,
      connectedBy: USER,
      scopes: ['adsread', 'adsedit'],
    },
  };
}

describe('BrokerCredentialSource [fake broker]', () => {
  it('signs a short-lived EdDSA service token bound to the workspace and caches until shortly before expiry', async () => {
    const { privateKey, publicKey } = keys();
    let now = Date.parse('2026-11-09T10:00:00Z');
    const http = new ScriptedHttpTransport([granted('2026-11-09T11:00:00Z'), granted('2026-11-09T12:00:00Z')]);
    const source = new BrokerCredentialSource(BROKER, privateKey, http, { now: () => now });

    const first = await source.get({ workspaceId: WS, purpose: 'mutate', userId: USER, initiatedBy: 'user', traceId: 't-1' });
    expect(first).toEqual({
      ok: true,
      credentials: { tokenSource: 'broker', accessToken: 'brokered-test-token', accountId: 'a2_connected', connectionId: CONNECTION, connectedBy: USER },
    });
    expect(http.calls).toHaveLength(1);
    const call = http.calls[0]!;
    expect(call.url).toBe('http://hub:3000/v1/internal/connections/reddit/access-token');
    expect(JSON.parse(call.body!)).toEqual({ workspaceId: WS, purpose: 'mutate', userId: USER, initiatedBy: 'user', traceId: 't-1' });
    const jwt = call.headers.authorization!.replace(/^Bearer /, '');
    const { payload, protectedHeader } = await jwtVerify(jwt, publicKey, {
      issuer: 'proba-ads',
      audience: 'proba-hub',
      subject: 'ads',
      currentDate: new Date(now),
    });
    expect(protectedHeader).toMatchObject({ alg: 'EdDSA', kid: 'ads-svc-1' });
    expect(payload.workspaceId).toBe(WS);
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(120);
    expect(typeof payload.jti).toBe('string');

    now += 5 * 60_000;
    await source.get({ workspaceId: WS, purpose: 'metrics' });
    expect(http.calls).toHaveLength(1);

    now += 6 * 60_000; // past the 10 minute reuse cap
    await source.get({ workspaceId: WS, purpose: 'metrics', initiatedBy: 'policy' });
    expect(http.calls).toHaveLength(2);
    expect(JSON.parse(http.calls[1]!.body!).initiatedBy).toBe('policy');
  });

  it('maps broker answers to fail-closed codes and does not cache failures', async () => {
    const { privateKey } = keys();
    const http = new ScriptedHttpTransport([
      { status: 409, body: { error: 'not_connected', message: 'Connect Reddit in Marketing' } },
      { status: 409, body: { error: 'account_not_selected', message: 'pick an account' } },
      { status: 409, body: { error: 'needs_reconnect', message: 'reconnect' } },
      { status: 503, body: { error: 'provider_unavailable' } },
      { network: true },
      { status: 401, body: { error: 'invalid_token' } },
      { status: 200, body: { accessToken: 'x' } },
    ]);
    const source = new BrokerCredentialSource(BROKER, privateKey, http);
    const codes = [];
    for (let i = 0; i < 7; i += 1) {
      const r = await source.get({ workspaceId: WS, purpose: 'preflight' });
      codes.push(r.ok ? 'ok' : r.code);
    }
    expect(codes).toEqual([
      'not_connected',
      'account_not_selected',
      'needs_reconnect',
      'broker_unavailable',
      'broker_unavailable',
      'broker_refused',
      'broker_refused',
    ]);
  });

  it('static file source reports file attribution without a connection id', async () => {
    const r = await new StaticCredentialSource({ accessToken: 'file-test-token', accountId: 'a2_file' }).get();
    expect(r).toEqual({ ok: true, credentials: { tokenSource: 'file', accessToken: 'file-test-token', accountId: 'a2_file' } });
  });
});
