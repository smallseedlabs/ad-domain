import { describe, expect, it } from 'vitest';
import { ConfigError } from './errors.js';
import { loadConfig } from './config.js';

describe('config [unit]', () => {
  it('defaults to port 3800 and audience-related caller allowlists', () => {
    const config = loadConfig({ NODE_ENV: 'test', AUDIT_PUBLISHER: 'log' });
    expect(config.listen.port).toBe(3800);
    expect(config.auth.allowedIssuers).toEqual(['proba-gateway']);
    expect(config.auth.allowedSubjects).toEqual(['gateway']);
    expect(config.ads.maxDailyBudget).toBeNull();
    expect(config.ads.researchAcceptanceMode).toBe('closed');
    expect(config.audit.stream).toBe('proba.audit.events');
  });

  it('refuses public ingress, non-Reddit provider secrets, and Reddit client-secret refresh', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', INGRESS_PUBLIC: 'true' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'test', REDDIT_CLIENT_SECRET: 'x' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'test', META_ACCESS_TOKEN: 'x' })).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        AUDIT_PUBLISHER: 'redis',
        REDIS_URL: 'redis://127.0.0.1:9',
        DATABASE_URL: 'postgres://ads:x@127.0.0.1:9/ad_domain',
        GATEWAY_SERVICE_PUBLIC_KEY_FILE: '/tmp/does-not-need-to-exist-for-this-assert.jwks',
        ADS_RESEARCH_ACCEPTANCE_MODE: 'shape',
      })
    ).toThrow(/shape is refused/);
  });

  it('does not register Reddit unless explicitly enabled with account and token', () => {
    const off = loadConfig({ NODE_ENV: 'test', AUDIT_PUBLISHER: 'log' });
    expect(off.reddit.enabled).toBe(false);
    expect(() =>
      loadConfig({ NODE_ENV: 'test', AUDIT_PUBLISHER: 'log', REDDIT_ADS_ENABLED: 'true', REDDIT_AD_ACCOUNT_ID: 'a2_test' })
    ).toThrow(ConfigError);
    const on = loadConfig({
      NODE_ENV: 'test',
      AUDIT_PUBLISHER: 'log',
      REDDIT_ADS_ENABLED: 'true',
      REDDIT_AD_ACCOUNT_ID: 'a2_test',
      REDDIT_ACCESS_TOKEN: 'test-token-not-real',
    });
    expect(on.reddit.enabled).toBe(true);
    if (on.reddit.enabled && on.reddit.tokenSource === 'file') {
      expect(on.reddit.adAccountId).toBe('a2_test');
      expect(on.reddit.reportMaxPages).toBe(10);
    }
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        AUDIT_PUBLISHER: 'log',
        REDDIT_ADS_ENABLED: 'true',
        REDDIT_AD_ACCOUNT_ID: 'a2_test',
        REDDIT_ACCESS_TOKEN: 'test-token-not-real',
        REDDIT_CONVERSION_PIXEL_ID: 'not a pixel',
      })
    ).toThrow(ConfigError);
  });
});

describe('REDDIT_TOKEN_SOURCE=broker', () => {
  const base = { NODE_ENV: 'test', AUDIT_PUBLISHER: 'log', REDDIT_ADS_ENABLED: 'true', REDDIT_TOKEN_SOURCE: 'broker' };
  it('needs the broker URL and service key, and no token or account in env', () => {
    const on = loadConfig({ ...base, CONNECTION_BROKER_URL: 'http://hub:3000/', ADS_SERVICE_PRIVATE_KEY_FILE: '/run/keys/ads.pem' });
    expect(on.reddit).toMatchObject({ enabled: true, tokenSource: 'broker', broker: { url: 'http://hub:3000', keyId: 'ads-svc-1' } });
    expect(() => loadConfig({ ...base, ADS_SERVICE_PRIVATE_KEY_FILE: '/k' })).toThrow(/CONNECTION_BROKER_URL/);
    expect(() => loadConfig({ ...base, CONNECTION_BROKER_URL: 'http://hub:3000' })).toThrow(/ADS_SERVICE_PRIVATE_KEY_FILE/);
    const ok = { ...base, CONNECTION_BROKER_URL: 'http://hub:3000', ADS_SERVICE_PRIVATE_KEY_FILE: '/k' };
    expect(() => loadConfig({ ...ok, REDDIT_ACCESS_TOKEN: 'test-token-not-real' })).toThrow(/unset REDDIT_ACCESS_TOKEN/);
    expect(() => loadConfig({ ...ok, REDDIT_AD_ACCOUNT_ID: 'a2_x' })).toThrow(/unset REDDIT_AD_ACCOUNT_ID/);
    expect(() => loadConfig({ ...ok, REDDIT_CLIENT_SECRET: 'x' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...ok, CONNECTION_BROKER_ALLOWED_HOSTS: 'other:3000' })).toThrow(/not in CONNECTION_BROKER_ALLOWED_HOSTS/);
    expect(() => loadConfig({ ...base, REDDIT_TOKEN_SOURCE: 'magic' })).toThrow(/file or broker/);
  });
});
