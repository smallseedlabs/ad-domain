import type { AuditEvent } from '../protocol.js';
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
    };
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
