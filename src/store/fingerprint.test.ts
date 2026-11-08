import { describe, expect, it } from 'vitest';
import { requestFingerprint } from './fingerprint.js';

describe('requestFingerprint [unit]', () => {
  it('is stable under key order and differs when args differ', () => {
    const a = requestFingerprint('ads.create_campaign', { name: 'a', dailyBudget: 1, currency: 'USD' });
    const b = requestFingerprint('ads.create_campaign', { currency: 'USD', dailyBudget: 1, name: 'a' });
    const c = requestFingerprint('ads.create_campaign', { name: 'b', dailyBudget: 1, currency: 'USD' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
