import { randomUUID } from 'node:crypto';
import { AmbiguousOutcomeError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { VerifiedCaller } from '../ports/auth.js';
import { adsAuditEvent } from '../audit/emit.js';
import type { CampaignRecord } from '../store/port.js';
import { executeMetricsFetch, type AnalyticsDeps } from './analytics.js';

/**
 * Scheduled Reddit metrics sync.
 *
 * Each run lists campaigns that already carry a Reddit campaign + account mapping (status
 * active or paused) and, one at a time, calls the same executeMetricsFetch the gateway uses,
 * with initiatedBy=system, so the Hub broker issues a short-lived token for the campaign's
 * own workspace and connected account. Reporting is read-only: no campaign, budget or ad is
 * ever mutated here.
 *
 * Window: from UTC midnight `lookbackDays` ago up to the start of the current UTC hour
 * (Reddit report starts_at/ends_at are hour-aligned). The idempotency key is
 * campaign + window, so two runs in the same hour replay instead of refetching, and the
 * next hour fetches again to pick up Reddit's restatements.
 *
 * Every fetch is audited by executeMetricsFetch (command.received, metrics.fetch_started,
 * metrics.ingested, metrics.fetch_completed / metrics.fetch_failed, command.rejected).
 * Anything that throws is audited here as metrics.fetch_failed, and each run ends with
 * system.job_run per workspace (or system.job_failed if the campaign list could not be read).
 */

export const METRICS_SYNC_JOB = 'ads.metrics_sync';
const SYNC_CALLER_ISSUER = 'proba-ads';
const SYNC_CALLER_SUBJECT = 'metrics-sync';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SYSTEM_WORKSPACE = 'seedbed';

export interface MetricsSyncDeps extends AnalyticsDeps {
  logger?: Logger;
}

export type CampaignSyncOutcome = 'ingested' | 'failed' | 'in_flight' | 'error';

export interface CampaignSyncResult {
  workspaceId: string;
  probaCampaignId: string;
  traceId: string;
  outcome: CampaignSyncOutcome;
  code?: string;
}

export interface MetricsSyncRunReport {
  runId: string;
  periodStart: string;
  periodEnd: string;
  campaigns: number;
  counts: Record<CampaignSyncOutcome, number>;
  results: CampaignSyncResult[];
}

export function metricsSyncWindow(now: Date, lookbackDays: number): { periodStart: string; periodEnd: string } {
  const end = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const startDay = Math.floor((end - lookbackDays * DAY_MS) / DAY_MS) * DAY_MS;
  return { periodStart: new Date(startDay).toISOString(), periodEnd: new Date(end).toISOString() };
}

export function metricsSyncIdempotencyKey(probaCampaignId: string, periodStart: string, periodEnd: string): string {
  return `metrics-sync:${probaCampaignId}:${periodStart}:${periodEnd}`;
}

function syncCaller(campaign: CampaignRecord, now: Date): VerifiedCaller {
  return {
    issuer: SYNC_CALLER_ISSUER,
    subject: SYNC_CALLER_SUBJECT,
    jti: randomUUID(),
    keyId: 'in-process',
    expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    workspaceId: campaign.workspaceId,
  };
}

async function audit(deps: MetricsSyncDeps, event: Parameters<typeof adsAuditEvent>[0]): Promise<void> {
  await deps.store.withTransaction(async (tx) => tx.enqueueAudit(adsAuditEvent(event)));
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

async function syncCampaign(
  deps: MetricsSyncDeps,
  campaign: CampaignRecord,
  window: { periodStart: string; periodEnd: string }
): Promise<CampaignSyncResult> {
  const traceId = randomUUID();
  const base = { workspaceId: campaign.workspaceId, probaCampaignId: campaign.probaCampaignId, traceId };
  try {
    const result = await executeMetricsFetch(
      deps,
      {
        traceId,
        workspaceId: campaign.workspaceId,
        userId: campaign.userId,
        ...(campaign.goalId ? { goalId: campaign.goalId } : {}),
        probaCampaignId: campaign.probaCampaignId,
        periodStart: window.periodStart,
        periodEnd: window.periodEnd,
        granularity: 'day',
        timezone: 'UTC',
        initiatedBy: 'system',
      },
      syncCaller(campaign, deps.clock.now()),
      metricsSyncIdempotencyKey(campaign.probaCampaignId, window.periodStart, window.periodEnd)
    );
    if (result.ok) return { ...base, outcome: 'ingested' };
    return { ...base, outcome: 'failed', code: result.code };
  } catch (err) {
    if (err instanceof AmbiguousOutcomeError) {
      // This exact window is held by another run (or ended ambiguous); that attempt audits itself.
      return { ...base, outcome: 'in_flight', code: err.code };
    }
    const code = (err as { code?: unknown } | null)?.code;
    const errorCode = typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : 'metrics_sync_error';
    deps.logger?.warn(
      { campaignId: campaign.probaCampaignId, workspaceId: campaign.workspaceId, traceId, errorCode, errorName: errorName(err) },
      'metrics sync fetch threw'
    );
    try {
      await audit(deps, {
        action: 'metrics.fetch_failed',
        outcome: 'failure',
        traceId,
        workspaceId: campaign.workspaceId,
        userId: campaign.userId,
        goalId: campaign.goalId,
        campaignId: campaign.probaCampaignId,
        clock: deps.clock,
        errorCode,
        details: {
          job: METRICS_SYNC_JOB,
          platform: campaign.platform,
          periodStart: window.periodStart,
          periodEnd: window.periodEnd,
          initiatedBy: 'system',
          errorName: errorName(err),
          campaignMutated: false,
        },
      });
    } catch (auditErr) {
      deps.logger?.error({ traceId, errorName: errorName(auditErr) }, 'metrics sync could not audit a failed fetch');
    }
    return { ...base, outcome: 'error', code: errorCode };
  }
}

/** One sync pass. Never throws: failures are audited and returned in the run report. */
export async function runMetricsSyncOnce(deps: MetricsSyncDeps): Promise<MetricsSyncRunReport> {
  const runId = randomUUID();
  const window = metricsSyncWindow(deps.clock.now(), deps.config.metricsSync.lookbackDays);
  const counts: Record<CampaignSyncOutcome, number> = { ingested: 0, failed: 0, in_flight: 0, error: 0 };
  const report: MetricsSyncRunReport = { runId, ...window, campaigns: 0, counts, results: [] };
  const startedAt = deps.clock.now().getTime();

  let campaigns: CampaignRecord[];
  try {
    campaigns = await deps.store.listMetricsSyncTargets('reddit', deps.config.metricsSync.maxCampaignsPerRun);
  } catch (err) {
    deps.logger?.error({ runId, errorName: errorName(err) }, 'metrics sync could not list campaigns');
    try {
      await audit(deps, {
        action: 'system.job_failed',
        outcome: 'failure',
        traceId: runId,
        workspaceId: SYSTEM_WORKSPACE,
        clock: deps.clock,
        errorCode: 'metrics_sync_list_failed',
        details: { job: METRICS_SYNC_JOB, ...window, errorName: errorName(err) },
      });
    } catch {
      // The store is what failed; the log line above is the record.
    }
    return report;
  }

  report.campaigns = campaigns.length;
  for (const campaign of campaigns) {
    const result = await syncCampaign(deps, campaign, window);
    counts[result.outcome] += 1;
    report.results.push(result);
  }

  const durationMs = Math.max(0, deps.clock.now().getTime() - startedAt);
  const byWorkspace = new Map<string, CampaignSyncResult[]>();
  for (const r of report.results) byWorkspace.set(r.workspaceId, [...(byWorkspace.get(r.workspaceId) ?? []), r]);
  if (byWorkspace.size === 0) byWorkspace.set(SYSTEM_WORKSPACE, []);
  for (const [workspaceId, results] of byWorkspace) {
    const wsCounts: Record<CampaignSyncOutcome, number> = { ingested: 0, failed: 0, in_flight: 0, error: 0 };
    for (const r of results) wsCounts[r.outcome] += 1;
    const failures = wsCounts.failed + wsCounts.error;
    try {
      await audit(deps, {
        action: 'system.job_run',
        outcome: failures === 0 ? 'success' : wsCounts.ingested > 0 ? 'partial' : 'failure',
        traceId: runId,
        workspaceId,
        clock: deps.clock,
        ...(failures > 0 ? { errorCode: 'metrics_sync_failures' } : {}),
        details: {
          job: METRICS_SYNC_JOB,
          platform: 'reddit',
          ...window,
          durationMs,
          campaigns: results.length,
          counts: wsCounts,
          results: results.map((r) => ({ campaignId: r.probaCampaignId, traceId: r.traceId, outcome: r.outcome, code: r.code })),
          campaignMutated: false,
        },
      });
    } catch (err) {
      deps.logger?.error({ runId, errorName: errorName(err) }, 'metrics sync could not audit the run');
    }
  }
  deps.logger?.info({ runId, ...window, campaigns: campaigns.length, counts, durationMs }, 'metrics sync run finished');
  return report;
}

/** setTimeout chain with a no-overlap guard. Does nothing unless config.metricsSync.enabled. */
export class MetricsSyncScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<MetricsSyncRunReport> | undefined;
  private stopped = false;

  constructor(private readonly deps: MetricsSyncDeps) {}

  get enabled(): boolean {
    return this.deps.config.metricsSync.enabled;
  }

  start(): void {
    if (!this.enabled || this.timer || this.stopped) return;
    const { initialDelayMs, intervalMs } = this.deps.config.metricsSync;
    const schedule = (delay: number) => {
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        void this.tick().finally(() => schedule(intervalMs));
      }, delay);
      this.timer.unref();
    };
    schedule(initialDelayMs);
  }

  /** Runs one pass unless one is already running (then resolves undefined). */
  async tick(): Promise<MetricsSyncRunReport | undefined> {
    if (this.running || this.stopped) {
      if (this.running) this.deps.logger?.warn('metrics sync run skipped: previous run still in progress');
      return undefined;
    }
    const run = runMetricsSyncOnce(this.deps);
    this.running = run;
    try {
      return await run;
    } finally {
      this.running = undefined;
    }
  }

  /** Stops scheduling and waits for an in-progress run to finish (its writes are transactional). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }
}
