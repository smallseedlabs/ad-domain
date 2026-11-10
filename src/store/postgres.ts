import pg from 'pg';
import type { AuditEvent } from '../protocol.js';
import type { AdPlatform } from '../types/http.js';
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

import { METRICS_SYNC_STATUSES } from './port.js';

pg.types.setTypeParser(20, (val) => parseInt(val, 10));
pg.types.setTypeParser(1700, (val) => Number(val));

type Queryable = Pick<pg.PoolClient, 'query'>;

function asCommand(row: pg.QueryResultRow): CommandRecord {
  return {
    workspaceId: String(row.workspace_id),
    idempotencyKey: String(row.idempotency_key),
    fingerprint: String(row.fingerprint),
    verb: String(row.verb),
    request: row.request,
    status: row.status as CommandStatus,
    result: (row.result as CommandRecord['result']) ?? null,
    campaignId: row.campaign_id ? String(row.campaign_id) : null,
  };
}

function asCampaign(row: pg.QueryResultRow): CampaignRecord {
  return {
    workspaceId: String(row.workspace_id),
    probaCampaignId: String(row.proba_campaign_id),
    userId: String(row.user_id),
    goalId: row.goal_id ? String(row.goal_id) : undefined,
    name: String(row.name),
    landingPageUrl: String(row.landing_page_url),
    dailyBudget: Number(row.daily_budget),
    currency: String(row.currency),
    platform: row.platform as AdPlatform,
    status: row.status,
    version: Number(row.version),
    lockCommandKey: row.lock_command_key ? String(row.lock_command_key) : null,
    provider: row.provider ? (row.provider as AdPlatform) : undefined,
    providerAccountId: row.provider_account_id ? String(row.provider_account_id) : undefined,
    providerCampaignId: row.provider_campaign_id ? String(row.provider_campaign_id) : undefined,
    providerAdGroupId: row.provider_ad_group_id ? String(row.provider_ad_group_id) : undefined,
    providerAdId: row.provider_ad_id ? String(row.provider_ad_id) : undefined,
    reconcile: (row.reconcile as Record<string, unknown> | null) ?? null,
  };
}

function txImpl(client: Queryable): AdsTx {
  return {
    async claimCommand(input) {
      const inserted = await client.query(
        `INSERT INTO ads.commands (workspace_id, idempotency_key, fingerprint, verb, request, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'pending')
         ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [input.workspaceId, input.idempotencyKey, input.fingerprint, input.verb, JSON.stringify(input.request)]
      );
      if (inserted.rows[0]) {
        return { kind: 'claimed', record: asCommand(inserted.rows[0]) } satisfies ClaimNew;
      }
      const existing = await client.query(
        `SELECT * FROM ads.commands WHERE workspace_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [input.workspaceId, input.idempotencyKey]
      );
      return { kind: 'existing', record: asCommand(existing.rows[0]) } satisfies ClaimExisting;
    },
    async completeCommand(input) {
      await client.query(
        `UPDATE ads.commands
         SET status = $3, result = $4::jsonb, campaign_id = COALESCE($5::uuid, campaign_id), updated_at = now()
         WHERE workspace_id = $1 AND idempotency_key = $2`,
        [input.workspaceId, input.idempotencyKey, input.status, JSON.stringify(input.result), input.campaignId ?? null]
      );
    },
    async markInFlight(workspaceId, idempotencyKey, campaignId) {
      await client.query(
        `UPDATE ads.commands SET status = 'in_flight', campaign_id = $3::uuid, updated_at = now()
         WHERE workspace_id = $1 AND idempotency_key = $2`,
        [workspaceId, idempotencyKey, campaignId]
      );
    },
    async getCampaign(workspaceId, probaCampaignId) {
      const result = await client.query(`SELECT * FROM ads.campaigns WHERE workspace_id = $1 AND proba_campaign_id = $2::uuid`, [
        workspaceId,
        probaCampaignId,
      ]);
      return result.rows[0] ? asCampaign(result.rows[0]) : undefined;
    },
    async insertCampaign(row) {
      await client.query(
        `INSERT INTO ads.campaigns (
           workspace_id, proba_campaign_id, user_id, goal_id, name, landing_page_url, daily_budget, currency,
           platform, status, version, lock_command_key, provider, provider_account_id, provider_campaign_id,
           provider_ad_group_id, provider_ad_id, reconcile
         ) VALUES ($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)`,
        [
          row.workspaceId,
          row.probaCampaignId,
          row.userId,
          row.goalId ?? null,
          row.name,
          row.landingPageUrl,
          row.dailyBudget,
          row.currency,
          row.platform,
          row.status,
          row.version,
          row.lockCommandKey ?? null,
          row.provider ?? null,
          row.providerAccountId ?? null,
          row.providerCampaignId ?? null,
          row.providerAdGroupId ?? null,
          row.providerAdId ?? null,
          row.reconcile ? JSON.stringify(row.reconcile) : null,
        ]
      );
    },
    async updateCampaignCas(workspaceId, probaCampaignId, expectedVersion, patch) {
      const result = await client.query(
        `UPDATE ads.campaigns SET
           name = COALESCE($4, name),
           landing_page_url = COALESCE($5, landing_page_url),
           daily_budget = COALESCE($6, daily_budget),
           status = COALESCE($7, status),
           lock_command_key = $8,
           provider = COALESCE($9, provider),
           provider_account_id = COALESCE($10, provider_account_id),
           provider_campaign_id = COALESCE($11, provider_campaign_id),
           provider_ad_group_id = COALESCE($12, provider_ad_group_id),
           provider_ad_id = COALESCE($13, provider_ad_id),
           reconcile = COALESCE($14::jsonb, reconcile),
           version = version + 1,
           updated_at = now()
         WHERE workspace_id = $1 AND proba_campaign_id = $2::uuid AND version = $3
         RETURNING *`,
        [
          workspaceId,
          probaCampaignId,
          expectedVersion,
          patch.name ?? null,
          patch.landingPageUrl ?? null,
          patch.dailyBudget ?? null,
          patch.status ?? null,
          patch.lockCommandKey === undefined ? null : patch.lockCommandKey,
          patch.provider ?? null,
          patch.providerAccountId ?? null,
          patch.providerCampaignId ?? null,
          patch.providerAdGroupId ?? null,
          patch.providerAdId ?? null,
          patch.reconcile ? JSON.stringify(patch.reconcile) : null,
        ]
      );
      return result.rows[0] ? asCampaign(result.rows[0]) : undefined;
    },
    async lockCampaign(workspaceId, probaCampaignId) {
      const result = await client.query(
        `SELECT * FROM ads.campaigns WHERE workspace_id = $1 AND proba_campaign_id = $2::uuid FOR UPDATE`,
        [workspaceId, probaCampaignId]
      );
      return result.rows[0] ? asCampaign(result.rows[0]) : undefined;
    },
    async listAccounts(workspaceId, platform) {
      const result = await client.query(
        `SELECT * FROM ads.provider_accounts WHERE workspace_id = $1 AND platform = $2`,
        [workspaceId, platform]
      );
      return result.rows.map(
        (row): ProviderAccountRecord => ({
          workspaceId: String(row.workspace_id),
          platform: row.platform as AdPlatform,
          accountId: String(row.account_id),
          status: row.status,
        })
      );
    },
    async upsertAccount(row) {
      await client.query(
        `INSERT INTO ads.provider_accounts (workspace_id, platform, account_id, status)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (workspace_id, platform, account_id) DO UPDATE SET status = EXCLUDED.status`,
        [row.workspaceId, row.platform, row.accountId, row.status]
      );
    },
    async enqueueAudit(event) {
      await client.query(
        `INSERT INTO ads.audit_outbox (event_id, payload) VALUES ($1::uuid, $2::jsonb) ON CONFLICT (event_id) DO NOTHING`,
        [event.eventId, JSON.stringify(event)]
      );
    },
  };
}

export class PostgresStore implements AdsStore {
  constructor(private readonly pool: pg.Pool) {}

  async withTransaction<T>(fn: (tx: AdsTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(txImpl(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listMetricsSyncTargets(platform: AdPlatform, limit: number): Promise<CampaignRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ads.campaigns
        WHERE platform = $1 AND status = ANY($2::text[])
          AND provider_campaign_id IS NOT NULL AND provider_account_id IS NOT NULL
        ORDER BY workspace_id, proba_campaign_id
        LIMIT $3`,
      [platform, [...METRICS_SYNC_STATUSES], limit]
    );
    return result.rows.map(asCampaign);
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async claimOutbox(limit: number, leaseMs: number): Promise<Array<{ id: string; event: AuditEvent }>> {
    const result = await this.pool.query(
      `UPDATE ads.audit_outbox SET locked_until = now() + ($2::int * interval '1 millisecond'), attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM ads.audit_outbox
         WHERE published_at IS NULL AND (locked_until IS NULL OR locked_until < now())
         ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       RETURNING id, payload`,
      [limit, leaseMs]
    );
    return result.rows
      .map((r) => ({ id: String(r.id), event: r.payload as AuditEvent }))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  async markOutboxPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(`UPDATE ads.audit_outbox SET published_at = now(), last_error = NULL WHERE id = ANY($1::bigint[])`, [ids]);
  }

  async markOutboxFailed(ids: string[], error: string): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(`UPDATE ads.audit_outbox SET last_error = $2 WHERE id = ANY($1::bigint[])`, [ids, error.slice(0, 1000)]);
  }
}
