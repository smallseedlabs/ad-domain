import type { AdPlatform } from '../types/http.js';

export interface GoalLedgerCaps {
  goalLifetimeCapUsd: number;
  goalDailyCapUsd: number;
  accountDailyCapUsd: number;
  maxLivePerGoal: number;
}

export interface LedgerReservationInput {
  workspaceId: string;
  goalId: string;
  campaignId: string;
  platform: AdPlatform;
  idempotencyKey: string;
  lifetimeAllocationUsd: number;
  dailyAllocationUsd: number;
  currency: string;
  nowIso: string;
}

export interface LedgerEntryRecord {
  id: string;
  workspaceId: string;
  goalId: string;
  campaignId?: string;
  platform?: AdPlatform;
  kind: 'reserve' | 'commit' | 'release' | 'spend_observation' | 'cap_adjustment';
  amountUsd: number;
  dailyAllocationUsd: number;
  currency: string;
  idempotencyKey: string;
  createdAt: string;
}

export type LedgerRefusalCode =
  | 'goal_lifetime_cap_exceeded'
  | 'goal_daily_cap_exceeded'
  | 'account_daily_cap_exceeded'
  | 'goal_max_live_exceeded';

export type LedgerCheckResult =
  | { ok: true; entryId: string }
  | { ok: false; code: LedgerRefusalCode; message: string };

export interface LedgerSnapshot {
  goalReservedLifetimeUsd: number;
  goalReservedDailyUsd: number;
  accountReservedDailyUsd: number;
  goalLiveCampaignCount: number;
}

export function evaluateLedgerReservation(
  snapshot: LedgerSnapshot,
  caps: GoalLedgerCaps,
  requested: { lifetimeAllocationUsd: number; dailyAllocationUsd: number; isNewLiveCampaign: boolean }
): { ok: true } | { ok: false; code: LedgerRefusalCode; message: string } {
  if (requested.isNewLiveCampaign && snapshot.goalLiveCampaignCount + 1 > caps.maxLivePerGoal) {
    return {
      ok: false,
      code: 'goal_max_live_exceeded',
      message: `Goal live campaign count (${snapshot.goalLiveCampaignCount + 1}) exceeds maxLivePerGoal (${caps.maxLivePerGoal}).`,
    };
  }
  if (snapshot.goalReservedLifetimeUsd + requested.lifetimeAllocationUsd > caps.goalLifetimeCapUsd) {
    return {
      ok: false,
      code: 'goal_lifetime_cap_exceeded',
      message: `Goal lifetime allocation (${snapshot.goalReservedLifetimeUsd + requested.lifetimeAllocationUsd}) exceeds goalLifetimeCapUsd (${caps.goalLifetimeCapUsd}).`,
    };
  }
  if (snapshot.goalReservedDailyUsd + requested.dailyAllocationUsd > caps.goalDailyCapUsd) {
    return {
      ok: false,
      code: 'goal_daily_cap_exceeded',
      message: `Goal daily allocation (${snapshot.goalReservedDailyUsd + requested.dailyAllocationUsd}) exceeds goalDailyCapUsd (${caps.goalDailyCapUsd}).`,
    };
  }
  if (snapshot.accountReservedDailyUsd + requested.dailyAllocationUsd > caps.accountDailyCapUsd) {
    return {
      ok: false,
      code: 'account_daily_cap_exceeded',
      message: `Account daily allocation (${snapshot.accountReservedDailyUsd + requested.dailyAllocationUsd}) exceeds accountDailyCapUsd (${caps.accountDailyCapUsd}).`,
    };
  }
  return { ok: true };
}
