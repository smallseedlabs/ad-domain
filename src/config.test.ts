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
    expect(config.audit.stream).toBe('proba.audit.events');
  });

  it('refuses public ingress, non-Reddit provider secrets, and Reddit client-secret refresh', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', INGRESS_PUBLIC: 'true' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'test', REDDIT_CLIENT_SECRET: 'x' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'test', META_ACCESS_TOKEN: 'x' })).toThrow(ConfigError);
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
    if (on.reddit.enabled) {
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
