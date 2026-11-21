import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger.js';
import type { VerifiedCaller } from '../ports/auth.js';
import type { CampaignRecord } from '../store/port.js';
import { executeCampaignAction, type ExecuteDeps } from './execute.js';

export const WATCHDOG_PAUSE_PACE_MULTIPLIER = 3;
export const WATCHDOG_WAKE_PACE_MULTIPLIER = 1.3;

export interface WatchdogPauseInput {
  workspaceId: string;
  userId: string;
  goalId?: string;
  probaCampaignId: string;
  reason: string;
}

/**
 * Narrow capability port for the spend watchdog.
 * By construction, the watchdog can only pause campaigns — it cannot create,
 * resume, or increase spend on any campaign.
 */
export interface WatchdogPort {
  pauseCampaign(input: WatchdogPauseInput): Promise<{ ok: boolean; code?: string }>;
}

export interface WatchdogEventRecord {
  id: string;
  workspaceId: string;
  goalId?: string;
  probaCampaignId: string;
  paceRatio: number;
  action: 'paused' | 'reviewer_woken';
  reason: string;
  createdAt: string;
}

export interface WatchdogObservation {
  campaign: CampaignRecord;
  observedDailySpend: number | null;
}

export interface WatchdogDeps {
  port: WatchdogPort;
  listActiveObservations: () => Promise<WatchdogObservation[]>;
  recordEvent: (event: WatchdogEventRecord) => Promise<void>;
  wakeReviewer?: (input: {
    workspaceId: string;
    goalId?: string;
    probaCampaignId: string;
    paceRatio: number;
  }) => Promise<void>;
  now?: () => Date;
  logger?: Logger;
}

export function createWatchdogPort(deps: ExecuteDeps): WatchdogPort {
  return {
    async pauseCampaign(input: WatchdogPauseInput): Promise<{ ok: boolean; code?: string }> {
      const now = deps.clock.now();
      const caller: VerifiedCaller = {
        issuer: 'proba-ads',
        subject: 'spend-watchdog',
        jti: randomUUID(),
        keyId: 'in-process',
        expiresAt: new Date(now.getTime() + 60_000),
        workspaceId: input.workspaceId,
      };
      const result = await executeCampaignAction(
        deps,
        {
          traceId: randomUUID(),
          workspaceId: input.workspaceId,
          userId: input.userId,
          ...(input.goalId ? { goalId: input.goalId } : {}),
          verb: 'ads.pause_campaign',
          initiatedBy: 'system',
          args: {
            probaCampaignId: input.probaCampaignId,
          },
        },
        caller,
        `watchdog-pause:${input.probaCampaignId}:${Math.floor(now.getTime() / 60_000)}`
      );
      return result.ok ? { ok: true } : { ok: false, code: result.code };
    },
  };
}

export async function runWatchdogTick(deps: WatchdogDeps): Promise<WatchdogEventRecord[]> {
  const now = (deps.now ?? (() => new Date()))();
  const observations = await deps.listActiveObservations();
  const events: WatchdogEventRecord[] = [];

  for (const { campaign, observedDailySpend } of observations) {
    if (campaign.status !== 'active') continue;
    if (typeof observedDailySpend !== 'number' || !Number.isFinite(observedDailySpend)) continue;
    if (campaign.dailyBudget <= 0) continue;

    const paceRatio = observedDailySpend / campaign.dailyBudget;
    if (paceRatio >= WATCHDOG_PAUSE_PACE_MULTIPLIER) {
      const reason = `Spend pace ${paceRatio.toFixed(2)}x exceeded ${WATCHDOG_PAUSE_PACE_MULTIPLIER}x limit`;
      const paused = await deps.port.pauseCampaign({
        workspaceId: campaign.workspaceId,
        userId: campaign.userId,
        goalId: campaign.goalId,
        probaCampaignId: campaign.probaCampaignId,
        reason,
      });
      if (!paused.ok) {
        deps.logger?.warn(
          { probaCampaignId: campaign.probaCampaignId, code: paused.code },
          'watchdog pause attempt did not succeed'
        );
      }
      const event: WatchdogEventRecord = {
        id: randomUUID(),
        workspaceId: campaign.workspaceId,
        goalId: campaign.goalId,
        probaCampaignId: campaign.probaCampaignId,
        paceRatio,
        action: 'paused',
        reason,
        createdAt: now.toISOString(),
      };
      await deps.recordEvent(event);
      events.push(event);
    } else if (paceRatio >= WATCHDOG_WAKE_PACE_MULTIPLIER) {
      const reason = `Spend pace ${paceRatio.toFixed(2)}x exceeded ${WATCHDOG_WAKE_PACE_MULTIPLIER}x reviewer threshold`;
      if (deps.wakeReviewer) {
        await deps.wakeReviewer({
          workspaceId: campaign.workspaceId,
          goalId: campaign.goalId,
          probaCampaignId: campaign.probaCampaignId,
          paceRatio,
        });
      }
      const event: WatchdogEventRecord = {
        id: randomUUID(),
        workspaceId: campaign.workspaceId,
        goalId: campaign.goalId,
        probaCampaignId: campaign.probaCampaignId,
        paceRatio,
        action: 'reviewer_woken',
        reason,
        createdAt: now.toISOString(),
      };
      await deps.recordEvent(event);
      events.push(event);
    }
  }

  return events;
}
