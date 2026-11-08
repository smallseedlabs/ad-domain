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

  it('refuses public ingress and provider secrets in this process', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', INGRESS_PUBLIC: 'true' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'test', REDDIT_CLIENT_SECRET: 'x' })).toThrow(ConfigError);
  });
});
