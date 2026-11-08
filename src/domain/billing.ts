import type { AdsServiceConfig } from '../types/config.js';
import type { AdsBillingClaim } from '../types/preflight.js';
import type { SpendClass } from './verbs.js';

export interface BillingDecision {
  ok: boolean;
  skipBalance: boolean;
  code?: string;
  message?: string;
}

/**
 * create/resume/spend-increase require authorized scope (caller) plus billing
 * readiness and any configured numeric cap. pause / non-increase updates may
 * skip ad-balance only — not auth, mapping, or hard limits.
 */
export function evaluateBillingGate(input: {
  claim: AdsBillingClaim;
  spendClass: SpendClass;
  dailyBudget?: number;
  currency?: string;
  config: AdsServiceConfig;
}): BillingDecision {
  const { claim, spendClass, dailyBudget, currency, config } = input;
  if (spendClass === 'none' || spendClass === 'safety_decrease') {
    return { ok: true, skipBalance: true };
  }

  if (config.ads.maxDailyBudget !== null && typeof dailyBudget === 'number') {
    if (config.ads.maxDailyBudgetCurrency && currency && currency !== config.ads.maxDailyBudgetCurrency) {
      return {
        ok: false,
        skipBalance: false,
        code: 'budget_cap',
        message: `dailyBudget currency ${currency} does not match configured cap currency ${config.ads.maxDailyBudgetCurrency}`,
      };
    }
    if (dailyBudget > config.ads.maxDailyBudget) {
      return {
        ok: false,
        skipBalance: false,
        code: 'budget_cap',
        message: `dailyBudget exceeds the configured Ads-domain cap ${config.ads.maxDailyBudget}`,
      };
    }
  }

  if (claim.kind === 'verified') {
    if (!claim.eligible) {
      return {
        ok: false,
        skipBalance: false,
        code: 'billing_not_ready',
        message:
          claim.mode === 'exact_balance'
            ? 'Ads domain reported insufficient provider funds'
            : 'Ads domain reported the workspace is not billing-eligible',
      };
    }
    return { ok: true, skipBalance: false };
  }

  return {
    ok: false,
    skipBalance: false,
    code: 'billing_not_ready',
    message:
      claim.kind === 'unavailable'
        ? claim.reason
        : claim.kind === 'unsupported'
          ? claim.reason
          : claim.kind === 'not_queried'
            ? 'provider billing was not queried; spend-increase is refused'
            : `${claim.kind === 'unknown' ? claim.reason : 'provider billing is not verified'}. Spend-increase is refused when billing is unknown.`,
  };
}
