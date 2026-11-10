import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { PostgresStore } from './postgres.js';
import type { CampaignRecord } from './port.js';
import { FIXTURE_USER_ID } from '../testing/config.js';
import { realPostgresUrl } from '../testing/real-env.js';

describe.skipIf(!realPostgresUrl())('listMetricsSyncTargets [real-pg]', () => {
  let pool: pg.Pool;
  let store: PostgresStore;
  const workspace = `ws-sync-${randomUUID()}`;

  function row(patch: Partial<CampaignRecord>): CampaignRecord {
    return {
      workspaceId: workspace,
      probaCampaignId: randomUUID(),
      userId: FIXTURE_USER_ID,
      name: 'sync',
      landingPageUrl: 'https://example.test/offer',
      dailyBudget: 5,
      currency: 'GBP',
      platform: 'reddit',
      status: 'active',
      version: 1,
      provider: 'reddit',
      providerAccountId: 'a2_sync',
      providerCampaignId: `cmp_${randomUUID().slice(0, 8)}`,
      ...patch,
    };
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: realPostgresUrl()! });
    await runMigrations(pool, 'ads');
    store = new PostgresStore(pool);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM ads.campaigns WHERE workspace_id = $1`, [workspace]);
    await pool.end();
  });

  it('returns only mapped active/paused Reddit campaigns, across workspaces, within the limit', async () => {
    const active = row({});
    const paused = row({ status: 'paused' });
    const rows = [
      active,
      paused,
      row({ status: 'draft' }),
      row({ status: 'failed' }),
      row({ status: 'ambiguous' }),
      row({ providerCampaignId: undefined }),
      row({ providerAccountId: undefined }),
      row({ platform: 'meta', provider: 'meta' }),
    ];
    await store.withTransaction(async (tx) => {
      for (const r of rows) await tx.insertCampaign(r);
    });

    const mine = (await store.listMetricsSyncTargets('reddit', 500)).filter((c) => c.workspaceId === workspace);
    expect(mine.map((c) => c.probaCampaignId).sort()).toEqual([active.probaCampaignId, paused.probaCampaignId].sort());
    const one = mine.find((c) => c.probaCampaignId === active.probaCampaignId)!;
    expect(one).toMatchObject({ userId: FIXTURE_USER_ID, providerAccountId: 'a2_sync', providerCampaignId: active.providerCampaignId });

    expect(await store.listMetricsSyncTargets('reddit', 1)).toHaveLength(1);
  });
});
