import { describe, expect, it, vi } from 'vitest';
import { SystemClock } from '../ports/clock.js';
import type { ProviderAdapter, ProviderCommand, ProviderOutcome } from '../providers/port.js';
import { MemoryStore } from '../store/memory.js';
import type { CampaignRecord } from '../store/port.js';
import { FIXTURE_USER_ID, FIXTURE_WORKSPACE, testConfig } from '../testing/config.js';
import type { AdsBillingClaim } from '../types/preflight.js';
import { createWatchdogPort, runWatchdogTick, type WatchdogEventRecord } from './watchdog.js';

function makeActiveCampaign(id: string, dailyBudget = 10): CampaignRecord {
  return {
    workspaceId: FIXTURE_WORKSPACE,
    probaCampaignId: id,
    userId: FIXTURE_USER_ID,
    goalId: '11111111-1111-4111-8111-111111111111',
    name: 'Watchdog Campaign',
    landingPageUrl: 'https://example.com',
    dailyBudget,
    currency: 'USD',
    platform: 'reddit',
    status: 'active',
    version: 1,
    provider: 'reddit',
    providerAccountId: 'act_1',
    providerCampaignId: 'cmp_1',
  };
}

describe('H1-04 spend watchdog', () => {
  it('pauses within one tick at 3x pace and records watchdog_events', async () => {
    const pauseCampaign = vi.fn(async () => ({ ok: true }));
    const wakeReviewer = vi.fn(async () => {});
    const events: WatchdogEventRecord[] = [];
    const campaign = makeActiveCampaign('22222222-2222-4222-8222-222222222222', 10);

    const out = await runWatchdogTick({
      port: { pauseCampaign },
      listActiveObservations: async () => [{ campaign, observedDailySpend: 30 }],
      recordEvent: async (e) => {
        events.push(e);
      },
      wakeReviewer,
      now: () => new Date('2026-11-21T20:00:00.000Z'),
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ action: 'paused', paceRatio: 3 });
    expect(pauseCampaign).toHaveBeenCalledTimes(1);
    expect(wakeReviewer).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });

  it('wakes hub reviewer at 1.3x pace without pausing', async () => {
    const pauseCampaign = vi.fn(async () => ({ ok: true }));
    const wakeReviewer = vi.fn(async () => {});
    const events: WatchdogEventRecord[] = [];
    const campaign = makeActiveCampaign('33333333-3333-4333-8333-333333333333', 10);

    const out = await runWatchdogTick({
      port: { pauseCampaign },
      listActiveObservations: async () => [{ campaign, observedDailySpend: 13 }],
      recordEvent: async (e) => {
        events.push(e);
      },
      wakeReviewer,
      now: () => new Date('2026-11-21T20:00:00.000Z'),
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ action: 'reviewer_woken', paceRatio: 1.3 });
    expect(pauseCampaign).not.toHaveBeenCalled();
    expect(wakeReviewer).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
  });

  it('port boundary: watchdog port can only call pauseCampaign (ads.pause_campaign)', async () => {
    const store = new MemoryStore();
    const campaign = makeActiveCampaign('44444444-4444-4444-8444-444444444444', 10);
    await store.withTransaction(async (tx) => {
      await tx.insertCampaign(campaign);
    });

    const mutatedVerbs: string[] = [];
    const provider: ProviderAdapter = {
      name: 'reddit',
      configured: true,
      async mutate(cmd: ProviderCommand): Promise<ProviderOutcome> {
        mutatedVerbs.push(cmd.verb);
        return {
          kind: 'success',
          mapping: {
            provider: 'reddit',
            providerCampaignId: 'cmp_1',
            providerAccountId: 'act_1',
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
          mode: 'billing_eligibility',
          asOf: '2026-11-21T20:00:00.000Z',
          source: 'ads_domain',
        };
      },
      async permissionState() {
        return { state: 'ready' as const };
      },
      async fetchCampaignMetrics() {
        return { kind: 'ok' as const, observations: [], quarantined: [], pages: 1 };
      },
    };

    const port = createWatchdogPort({
      config: testConfig(),
      store,
      provider,
      clock: new SystemClock(),
    });

    expect(Object.keys(port)).toEqual(['pauseCampaign']);
    const res = await port.pauseCampaign({
      workspaceId: FIXTURE_WORKSPACE,
      userId: FIXTURE_USER_ID,
      goalId: campaign.goalId,
      probaCampaignId: campaign.probaCampaignId,
      reason: '3x pace',
    });
    expect(res).toEqual({ ok: true });
    expect(mutatedVerbs).toEqual(['ads.pause_campaign']);
  });
});
