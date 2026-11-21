import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import type { VerifiedCaller } from '../ports/auth.js';
import { SystemClock } from '../ports/clock.js';
import type { ProviderAdapter, ProviderCommand, ProviderOutcome } from '../providers/port.js';
import { MemoryStore } from '../store/memory.js';
import {
  FIXTURE_GOAL_ID,
  FIXTURE_LANDING_PAGE_URL,
  FIXTURE_PROVIDER_POST_ID,
  FIXTURE_RESEARCH_ACCEPTANCE,
  FIXTURE_TRACE_ID,
  FIXTURE_USER_ID,
  FIXTURE_WORKSPACE,
} from '../testing/config.js';
import type { CampaignActionRequest } from '../types/http.js';
import type { AdsBillingClaim } from '../types/preflight.js';
import { executeCampaignAction } from './execute.js';

function fakeClock() {
  return new SystemClock();
}

const CALLER: VerifiedCaller = {
  subject: 'gateway',
  issuer: 'proba-gateway',
  scopes: ['ads.write', 'ads.spend_increase'],
  workspaceId: FIXTURE_WORKSPACE,
};

function makeProvider(options: { refuseCreate?: boolean; delayMs?: number } = {}): ProviderAdapter {
  let seq = 1;
  return {
    name: 'reddit',
    configured: true,
    async mutate(command: ProviderCommand): Promise<ProviderOutcome> {
      if (options.delayMs) {
        await new Promise((r) => setTimeout(r, options.delayMs));
      }
      if (options.refuseCreate) {
        return { kind: 'refused', code: 'provider_refused', message: 'Simulated provider refusal' };
      }
      return {
        kind: 'success',
        mapping: {
          provider: command.platform,
          providerAccountId: 'act_1',
          providerCampaignId: `cmp_${seq++}`,
          providerAdGroupId: `grp_${seq}`,
          providerAdId: `ad_${seq}`,
          launchKind: 'deliverable_ad',
          deliverableAd: true,
          clickUrlPushed: true,
        },
      };
    },
    async connectionState() {
      return { state: 'ready' };
    },
    async billingClaim(): Promise<AdsBillingClaim> {
      return {
        kind: 'verified',
        eligible: true,
        mode: 'funding_instrument',
        checkedAt: '2026-11-21T20:00:00.000Z',
        source: 'live',
      };
    },
    async fetchMetrics() {
      return { kind: 'ok', observations: [], quarantined: [], pages: 1 };
    },
  };
}

function createRequest(overrides: Partial<CampaignActionRequest> = {}): CampaignActionRequest {
  return {
    workspaceId: FIXTURE_WORKSPACE,
    userId: FIXTURE_USER_ID,
    goalId: FIXTURE_GOAL_ID,
    verb: 'ads.create_campaign',
    traceId: FIXTURE_TRACE_ID,
    args: {
      name: 'Ledger Test',
      landingPageUrl: FIXTURE_LANDING_PAGE_URL,
      dailyBudget: 30,
      currency: 'USD',
      platform: 'reddit',
      providerPostId: FIXTURE_PROVIDER_POST_ID,
      researchAcceptance: FIXTURE_RESEARCH_ACCEPTANCE,
    },
    ...overrides,
  };
}

describe('H1-02 transactional budget ledger', () => {
  it('refuses creates exceeding goal lifetime, goal daily, account daily, or maxLivePerGoal, and releases on provider refusal', async () => {
    const store = new MemoryStore();
    await store.withTransaction(async (tx) => {
      await tx.upsertAccount({
        workspaceId: FIXTURE_WORKSPACE,
        platform: 'reddit',
        accountId: 'act_1',
        status: 'ready',
      });
      await tx.setGoalBudgetCaps(FIXTURE_WORKSPACE, FIXTURE_GOAL_ID, {
        goalLifetimeCapUsd: 60,
        goalDailyCapUsd: 40,
        maxLivePerGoal: 2,
      });
    });

    const config = loadConfig({
      NODE_ENV: 'test',
      AUDIT_PUBLISHER: 'log',
      ADS_MAX_DAILY_BUDGET: '50',
    });

    const deps = {
      config,
      store,
      provider: makeProvider(),
      clock: fakeClock(),
      researchAcceptance: { verify: () => ({ ok: true as const }) },
    };

    // 1. Create 1st campaign ($30/day) -> succeeds
    const r1 = await executeCampaignAction(deps, createRequest(), CALLER, 'k1');
    expect(r1.ok).toBe(true);

    // 2. Create 2nd campaign ($25/day) -> exceeds goal daily cap (30 + 25 > 40)
    const r2 = await executeCampaignAction(
      deps,
      createRequest({ args: { ...createRequest().args, dailyBudget: 25 } }),
      CALLER,
      'k2'
    );
    expect(r2).toMatchObject({ ok: false, code: 'goal_daily_cap_exceeded' });

    // 3. Raise daily cap to 100 while keeping lifetime cap 60; $35/day exceeds goal lifetime cap (30 + 35 > 60)
    await store.withTransaction((tx) =>
      tx.setGoalBudgetCaps(FIXTURE_WORKSPACE, FIXTURE_GOAL_ID, {
        goalLifetimeCapUsd: 60,
        goalDailyCapUsd: 100,
        maxLivePerGoal: 2,
      })
    );
    const r3 = await executeCampaignAction(
      deps,
      createRequest({ args: { ...createRequest().args, dailyBudget: 35 } }),
      CALLER,
      'k3'
    );
    expect(r3).toMatchObject({ ok: false, code: 'goal_lifetime_cap_exceeded' });

    // 4. Provider refusal releases reservation so subsequent create fits
    const refusingDeps = { ...deps, provider: makeProvider({ refuseCreate: true }) };
    const r4 = await executeCampaignAction(
      refusingDeps,
      createRequest({ args: { ...createRequest().args, dailyBudget: 10 } }),
      CALLER,
      'k4'
    );
    expect(r4).toMatchObject({ ok: false, code: 'provider_refused' });

    // 5. Subsequent create ($10/day) still succeeds (because k4 was released)
    const r5 = await executeCampaignAction(
      deps,
      createRequest({ args: { ...createRequest().args, dailyBudget: 10 } }),
      CALLER,
      'k5'
    );
    expect(r5.ok).toBe(true);

    // 6. Another goal requesting $15/day -> exceeds account daily cap (30 + 10 + 15 > 50)
    const rAccount = await executeCampaignAction(
      deps,
      createRequest({
        goalId: '22222222-2222-4222-8222-222222222222',
        args: { ...createRequest().args, dailyBudget: 15 },
      }),
      CALLER,
      'k_acct'
    );
    expect(rAccount).toMatchObject({ ok: false, code: 'account_daily_cap_exceeded' });

    // 7. 3rd live campaign on goal -> exceeds maxLivePerGoal (2)
    await store.withTransaction((tx) =>
      tx.setGoalBudgetCaps(FIXTURE_WORKSPACE, FIXTURE_GOAL_ID, {
        goalLifetimeCapUsd: 500,
        goalDailyCapUsd: 500,
        maxLivePerGoal: 2,
      })
    );
    const r6 = await executeCampaignAction(
      deps,
      createRequest({ args: { ...createRequest().args, dailyBudget: 5 } }),
      CALLER,
      'k6'
    );
    expect(r6).toMatchObject({ ok: false, code: 'goal_max_live_exceeded' });
  });

  it('allows exactly one of two concurrent creates for the same goal when only one fits', async () => {
    const store = new MemoryStore();
    const concurrentGoalId = '33333333-3333-4333-8333-333333333333';
    await store.withTransaction(async (tx) => {
      await tx.upsertAccount({
        workspaceId: FIXTURE_WORKSPACE,
        platform: 'reddit',
        accountId: 'act_1',
        status: 'ready',
      });
      await tx.setGoalBudgetCaps(FIXTURE_WORKSPACE, concurrentGoalId, {
        goalLifetimeCapUsd: 50,
        goalDailyCapUsd: 50,
        maxLivePerGoal: 1,
      });
    });

    const config = loadConfig({
      NODE_ENV: 'test',
      AUDIT_PUBLISHER: 'log',
      ADS_MAX_DAILY_BUDGET: '100',
    });
    const deps = {
      config,
      store,
      provider: makeProvider({ delayMs: 20 }),
      clock: fakeClock(),
      researchAcceptance: { verify: () => ({ ok: true as const }) },
    };

    const [a, b] = await Promise.all([
      executeCampaignAction(deps, createRequest({ goalId: concurrentGoalId }), CALLER, 'conc-1'),
      executeCampaignAction(deps, createRequest({ goalId: concurrentGoalId }), CALLER, 'conc-2'),
    ]);

    const successes = [a, b].filter((r) => r.ok);
    const failures = [a, b].filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ ok: false, code: 'goal_max_live_exceeded' });
  });
});
