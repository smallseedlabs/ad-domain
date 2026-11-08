import type { AuditEvent } from '../protocol.js';
import type { AdPlatform, AdsDomainResult } from '../types/http.js';

export type CommandStatus = 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'ambiguous';
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'failed' | 'ambiguous';

export interface CommandRecord {
  workspaceId: string;
  idempotencyKey: string;
  fingerprint: string;
  verb: string;
  request: unknown;
  status: CommandStatus;
  result: AdsDomainResult | null;
  campaignId: string | null;
}

export interface CampaignRecord {
  workspaceId: string;
  probaCampaignId: string;
  userId: string;
  goalId?: string;
  name: string;
  landingPageUrl: string;
  dailyBudget: number;
  currency: string;
  platform: AdPlatform;
  status: CampaignStatus;
  version: number;
  lockCommandKey?: string | null;
  provider?: AdPlatform;
  providerAccountId?: string;
  providerCampaignId?: string;
  providerAdGroupId?: string;
  providerAdId?: string;
  reconcile?: Record<string, unknown> | null;
}

export interface ProviderAccountRecord {
  workspaceId: string;
  platform: AdPlatform;
  accountId: string;
  status: 'unconfigured' | 'ready' | 'unauthorized';
}

export interface ClaimNew {
  kind: 'claimed';
  record: CommandRecord;
}

export interface ClaimExisting {
  kind: 'existing';
  record: CommandRecord;
}

export interface AdsTx {
  claimCommand(input: {
    workspaceId: string;
    idempotencyKey: string;
    fingerprint: string;
    verb: string;
    request: unknown;
  }): Promise<ClaimNew | ClaimExisting>;
  completeCommand(input: {
    workspaceId: string;
    idempotencyKey: string;
    status: CommandStatus;
    result: AdsDomainResult;
    campaignId?: string | null;
  }): Promise<void>;
  markInFlight(workspaceId: string, idempotencyKey: string, campaignId: string): Promise<void>;
  getCampaign(workspaceId: string, probaCampaignId: string): Promise<CampaignRecord | undefined>;
  insertCampaign(row: CampaignRecord): Promise<void>;
  updateCampaignCas(
    workspaceId: string,
    probaCampaignId: string,
    expectedVersion: number,
    patch: Partial<CampaignRecord>
  ): Promise<CampaignRecord | undefined>;
  lockCampaign(workspaceId: string, probaCampaignId: string): Promise<CampaignRecord | undefined>;
  listAccounts(workspaceId: string, platform: AdPlatform): Promise<ProviderAccountRecord[]>;
  upsertAccount(row: ProviderAccountRecord): Promise<void>;
  enqueueAudit(event: AuditEvent): Promise<void>;
}

export interface AdsStore {
  withTransaction<T>(fn: (tx: AdsTx) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
  claimOutbox?(limit: number, leaseMs: number): Promise<Array<{ id: string; event: AuditEvent }>>;
  markOutboxPublished?(ids: string[]): Promise<void>;
  markOutboxFailed?(ids: string[], error: string): Promise<void>;
}
