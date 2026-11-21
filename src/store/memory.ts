import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '../protocol.js';
import type { AdPlatform } from '../types/http.js';
import {
  evaluateLedgerReservation,
  type GoalLedgerCaps,
  type LedgerEntryRecord,
} from '../domain/ledger.js';
import { METRICS_SYNC_STATUSES } from './port.js';
import type {
  AdsStore,
  AdsTx,
  CampaignRecord,
  ClaimExisting,
  ClaimNew,
  CommandRecord,
  CommandStatus,
  ProviderAccountRecord,
} from './port.js';

class Mutex {
  private chain: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/**
 * In-process store for unit tests labeled [fake-store]. Not durable. Not used
 * in production.
 */
export class MemoryStore implements AdsStore {
  readonly commands = new Map<string, CommandRecord>();
  readonly campaigns = new Map<string, CampaignRecord>();
  readonly accounts = new Map<string, ProviderAccountRecord>();
  readonly outbox: AuditEvent[] = [];
  readonly goalCaps = new Map<
    string,
    Pick<GoalLedgerCaps, 'goalLifetimeCapUsd' | 'goalDailyCapUsd' | 'maxLivePerGoal'>
  >();
  readonly ledger: LedgerEntryRecord[] = [];
  private readonly mutex = new Mutex();

  private key(workspaceId: string, id: string): string {
    return `${workspaceId}\n${id}`;
  }

  withTransaction<T>(fn: (tx: AdsTx) => Promise<T>): Promise<T> {
    return this.mutex.run(() => fn(this.tx()));
  }

  private tx(): AdsTx {
    return {
      claimCommand: async (input) => {
        const k = this.key(input.workspaceId, input.idempotencyKey);
        const existing = this.commands.get(k);
        if (existing) return { kind: 'existing', record: { ...existing } } satisfies ClaimExisting;
        const record: CommandRecord = {
          workspaceId: input.workspaceId,
          idempotencyKey: input.idempotencyKey,
          fingerprint: input.fingerprint,
          verb: input.verb,
          request: input.request,
          status: 'pending',
          result: null,
          campaignId: null,
        };
        this.commands.set(k, record);
        return { kind: 'claimed', record: { ...record } } satisfies ClaimNew;
      },
      completeCommand: async (input) => {
        const row = this.commands.get(this.key(input.workspaceId, input.idempotencyKey));
        if (!row) return;
        row.status = input.status;
        row.result = input.result;
        row.campaignId = input.campaignId ?? row.campaignId;
      },
      markInFlight: async (workspaceId, idempotencyKey, campaignId) => {
        const row = this.commands.get(this.key(workspaceId, idempotencyKey));
        if (!row) return;
        row.status = 'in_flight';
        row.campaignId = campaignId;
      },
      getCampaign: async (workspaceId, probaCampaignId) => {
        const row = this.campaigns.get(this.key(workspaceId, probaCampaignId));
        return row ? { ...row } : undefined;
      },
      insertCampaign: async (row) => {
        this.campaigns.set(this.key(row.workspaceId, row.probaCampaignId), { ...row });
      },
      updateCampaignCas: async (workspaceId, probaCampaignId, expectedVersion, patch) => {
        const row = this.campaigns.get(this.key(workspaceId, probaCampaignId));
        if (!row || row.version !== expectedVersion) return undefined;
        Object.assign(row, patch, { version: expectedVersion + 1 });
        return { ...row };
      },
      lockCampaign: async (workspaceId, probaCampaignId) => {
        const row = this.campaigns.get(this.key(workspaceId, probaCampaignId));
        return row ? { ...row } : undefined;
      },
      listAccounts: async (workspaceId, platform) =>
        [...this.accounts.values()].filter((a) => a.workspaceId === workspaceId && a.platform === platform),
      upsertAccount: async (row) => {
        this.accounts.set(`${row.workspaceId}\n${row.platform}\n${row.accountId}`, { ...row });
      },
      enqueueAudit: async (event) => {
        this.outbox.push(event);
      },
      setGoalBudgetCaps: async (workspaceId, goalId, caps) => {
        this.goalCaps.set(this.key(workspaceId, goalId), { ...caps });
      },
      getGoalBudgetCaps: async (workspaceId, goalId) => {
        const found = this.goalCaps.get(this.key(workspaceId, goalId));
        return found ? { ...found } : undefined;
      },
      reserveGoalBudget: async (input) => {
        const existing = this.ledger.find(
          (e) =>
            e.workspaceId === input.workspaceId &&
            e.idempotencyKey === input.idempotencyKey &&
            e.kind === 'reserve'
        );
        if (existing) {
          return { ok: true, entryId: existing.id };
        }

        const releasedCampaigns = new Set(
          this.ledger
            .filter((e) => e.workspaceId === input.workspaceId && e.kind === 'release' && e.campaignId)
            .map((e) => `${e.campaignId}\n${e.idempotencyKey.replace(/:release$/, '')}`)
        );

        const activeReservations = this.ledger.filter(
          (e) =>
            e.workspaceId === input.workspaceId &&
            e.kind === 'reserve' &&
            !releasedCampaigns.has(`${e.campaignId ?? ''}\n${e.idempotencyKey}`)
        );

        const goalReservedLifetimeUsd = activeReservations
          .filter((e) => e.goalId === input.goalId)
          .reduce((sum, e) => sum + e.amountUsd, 0);
        const goalReservedDailyUsd = activeReservations
          .filter((e) => e.goalId === input.goalId)
          .reduce((sum, e) => sum + e.dailyAllocationUsd, 0);
        const accountReservedDailyUsd = activeReservations.reduce(
          (sum, e) => sum + e.dailyAllocationUsd,
          0
        );
        const goalLiveCampaignCount = new Set(
          activeReservations
            .filter((e) => e.goalId === input.goalId && e.campaignId)
            .map((e) => e.campaignId as string)
        ).size;

        const check = evaluateLedgerReservation(
          {
            goalReservedLifetimeUsd,
            goalReservedDailyUsd,
            accountReservedDailyUsd,
            goalLiveCampaignCount,
          },
          input.caps,
          {
            lifetimeAllocationUsd: input.lifetimeAllocationUsd,
            dailyAllocationUsd: input.dailyAllocationUsd,
            isNewLiveCampaign: input.isNewLiveCampaign,
          }
        );

        if (!check.ok) return check;

        const entryId = randomUUID();
        this.ledger.push({
          id: entryId,
          workspaceId: input.workspaceId,
          goalId: input.goalId,
          campaignId: input.campaignId,
          platform: input.platform,
          kind: 'reserve',
          amountUsd: input.lifetimeAllocationUsd,
          dailyAllocationUsd: input.dailyAllocationUsd,
          currency: input.currency,
          idempotencyKey: input.idempotencyKey,
          createdAt: input.nowIso,
        });
        return { ok: true, entryId };
      },
      releaseGoalBudget: async (input) => {
        const releaseKey = `${input.idempotencyKey}:release`;
        const already = this.ledger.some(
          (e) =>
            e.workspaceId === input.workspaceId &&
            e.idempotencyKey === releaseKey &&
            e.kind === 'release'
        );
        if (already) return;
        const original = this.ledger.find(
          (e) =>
            e.workspaceId === input.workspaceId &&
            e.idempotencyKey === input.idempotencyKey &&
            e.kind === 'reserve'
        );
        if (!original) return;
        this.ledger.push({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          goalId: input.goalId,
          campaignId: input.campaignId,
          platform: original.platform,
          kind: 'release',
          amountUsd: original.amountUsd,
          dailyAllocationUsd: original.dailyAllocationUsd,
          currency: original.currency,
          idempotencyKey: releaseKey,
          createdAt: input.nowIso,
        });
      },
    };
  }

  async listMetricsSyncTargets(platform: AdPlatform, limit: number): Promise<CampaignRecord[]> {
    return [...this.campaigns.values()]
      .filter(
        (c) =>
          c.platform === platform &&
          METRICS_SYNC_STATUSES.includes(c.status) &&
          Boolean(c.providerCampaignId) &&
          Boolean(c.providerAccountId)
      )
      .sort((a, b) => (a.workspaceId + a.probaCampaignId).localeCompare(b.workspaceId + b.probaCampaignId))
      .slice(0, limit)
      .map((c) => ({ ...c }));
  }

  async ping(): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    return;
  }

  async claimOutbox(limit: number, _leaseMs: number): Promise<Array<{ id: string; event: AuditEvent }>> {
    return this.outbox.slice(0, limit).map((event, i) => ({ id: String(i + 1), event }));
  }

  publishedOutboxIds: string[] = [];

  async markOutboxPublished(ids: string[]): Promise<void> {
    this.publishedOutboxIds.push(...ids);
  }

  async markOutboxFailed(_ids: string[], _error: string): Promise<void> {
    return;
  }

  forceCommandStatus(workspaceId: string, key: string, status: CommandStatus): void {
    const row = this.commands.get(this.key(workspaceId, key));
    if (row) row.status = status;
  }
}
