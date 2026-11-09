import {
  AmbiguousOutcomeError,
  IdempotencyConflictError,
  RequestValidationError,
  WorkspaceScopeError,
} from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { VerifiedCaller } from '../ports/auth.js';
import { METRICS_FETCH_VERB, type MetricsFetchQuery } from '../providers/metrics.js';
import type { ProviderAdapter } from '../providers/port.js';
import type { AdsStore, AdsTx, CampaignRecord, CommandRecord } from '../store/port.js';
import { requestFingerprint } from '../store/fingerprint.js';
import type { AdsServiceConfig } from '../types/config.js';
import type { AdsDomainResult, MetricsFetchRequest } from '../types/http.js';
import { adsAuditEvent } from '../audit/emit.js';
import { attributionDetails } from '../providers/attribution.js';
import { REDDIT_REPORT_DEFAULT_MAX_PAGES } from '../providers/reddit/config.js';

const MAX_DAY_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_HOUR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface AnalyticsDeps {
  config: AdsServiceConfig;
  store: AdsStore;
  provider: ProviderAdapter;
  clock: Clock;
}

function replay(record: CommandRecord): AdsDomainResult {
  if (record.result) return record.result;
  return {
    ok: false,
    code: 'outcome_ambiguous',
    message: 'previous attempt for this idempotency key has an uncertain outcome; it will not be retried',
  };
}

function fail(code: string, message: string): Extract<AdsDomainResult, { ok: false }> {
  return { ok: false, code, message };
}

const inProcessClaims = new Map<string, Promise<AdsDomainResult>>();

export async function executeMetricsFetch(
  deps: AnalyticsDeps,
  request: MetricsFetchRequest,
  caller: VerifiedCaller,
  idempotencyKey: string
): Promise<AdsDomainResult> {
  const claimKey = `${request.workspaceId}\n${idempotencyKey}`;
  const pending = inProcessClaims.get(claimKey);
  if (pending) return pending;
  const run = executeOnce(deps, request, caller, idempotencyKey).finally(() => {
    inProcessClaims.delete(claimKey);
  });
  inProcessClaims.set(claimKey, run);
  return run;
}

function assertWindow(request: MetricsFetchRequest): { granularity: 'hour' | 'day'; timezone: string } {
  const timezone = (request.timezone ?? 'UTC').trim() || 'UTC';
  if (timezone !== 'UTC' && timezone !== 'Etc/UTC') {
    throw new RequestValidationError(
      'this slice maps Reddit reports only with time_zone_id=UTC so protocol periodStart/periodEnd stay honest UTC instants; other IANA zones are not invented'
    );
  }
  const start = Date.parse(request.periodStart);
  const end = Date.parse(request.periodEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new RequestValidationError('periodEnd must be after periodStart');
  }
  const granularity = request.granularity ?? 'day';
  const span = end - start;
  if (granularity === 'hour' && span > MAX_HOUR_WINDOW_MS) {
    throw new RequestValidationError('hour granularity Reddit reports are limited to 7 days in this slice (official HOUR window cap)');
  }
  if (granularity === 'day' && span > MAX_DAY_WINDOW_MS) {
    throw new RequestValidationError('day granularity Reddit reports are limited to 31 days in this slice');
  }
  return { granularity, timezone: 'UTC' };
}

async function executeOnce(
  deps: AnalyticsDeps,
  request: MetricsFetchRequest,
  caller: VerifiedCaller,
  idempotencyKey: string
): Promise<AdsDomainResult> {
  if (caller.workspaceId && caller.workspaceId !== request.workspaceId) {
    throw new WorkspaceScopeError();
  }
  const window = assertWindow(request);
  const fingerprint = requestFingerprint(METRICS_FETCH_VERB, {
    probaCampaignId: request.probaCampaignId,
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
    granularity: window.granularity,
    timezone: window.timezone,
    providerAccountId: request.providerAccountId,
  });

  const prepared = await deps.store.withTransaction(async (tx) => {
    const claim = await tx.claimCommand({
      workspaceId: request.workspaceId,
      idempotencyKey,
      fingerprint,
      verb: METRICS_FETCH_VERB,
      request,
    });

    if (claim.kind === 'existing') {
      if (claim.record.fingerprint !== fingerprint) {
        await tx.enqueueAudit(
          adsAuditEvent({
            action: 'command.rejected',
            outcome: 'denied',
            traceId: request.traceId,
            workspaceId: request.workspaceId,
            userId: request.userId,
            goalId: request.goalId,
            clock: deps.clock,
            errorCode: 'idempotency_conflict',
            details: { verb: METRICS_FETCH_VERB, reason: 'idempotency key reused with different args' },
          })
        );
        throw new IdempotencyConflictError();
      }
      await tx.enqueueAudit(
        adsAuditEvent({
          action: 'command.duplicate',
          outcome: 'success',
          traceId: request.traceId,
          workspaceId: request.workspaceId,
          userId: request.userId,
          goalId: request.goalId,
          campaignId: claim.record.campaignId ?? undefined,
          clock: deps.clock,
          details: { verb: METRICS_FETCH_VERB, status: claim.record.status },
        })
      );
      if (claim.record.status === 'in_flight' || claim.record.status === 'ambiguous' || !claim.record.result) {
        throw new AmbiguousOutcomeError();
      }
      return { kind: 'replay' as const, result: replay(claim.record) };
    }

    await tx.enqueueAudit(
      adsAuditEvent({
        action: 'command.received',
        outcome: 'success',
        traceId: request.traceId,
        workspaceId: request.workspaceId,
        userId: request.userId,
        goalId: request.goalId,
        clock: deps.clock,
        details: { verb: METRICS_FETCH_VERB },
      })
    );

    if (!deps.provider.configured) {
      const result = fail(
        'provider_unconfigured',
        'No provider adapter is configured. Metrics were not fetched and no campaign mutation was attempted.'
      );
      await finishRejected(tx, deps, request, idempotencyKey, result);
      return { kind: 'done' as const, result };
    }

    const campaign = await tx.getCampaign(request.workspaceId, request.probaCampaignId);
    if (!campaign) {
      const result = fail('ownership_mismatch', 'campaign is not in this workspace');
      await finishRejected(tx, deps, request, idempotencyKey, result);
      return { kind: 'done' as const, result };
    }
    if (campaign.userId !== request.userId) {
      const result = fail('ownership_mismatch', 'campaign is not owned by this user');
      await finishRejected(tx, deps, request, idempotencyKey, result);
      return { kind: 'done' as const, result };
    }
    if (campaign.platform !== 'reddit') {
      const result = fail('ownership_mismatch', 'metrics fetch in this slice is Reddit-only; other platforms stay unconfigured');
      await finishRejected(tx, deps, request, idempotencyKey, result);
      return { kind: 'done' as const, result };
    }
    if (!campaign.providerCampaignId || !campaign.providerAccountId) {
      const result = fail(
        'provider_prerequisites_missing',
        'campaign has no Reddit campaign/account mapping; reports were not requested'
      );
      await finishRejected(tx, deps, request, idempotencyKey, result);
      return { kind: 'done' as const, result };
    }
    if (request.providerAccountId && request.providerAccountId !== campaign.providerAccountId) {
      const result = fail('ownership_mismatch', 'providerAccountId does not match this campaign mapping');
      await finishRejected(tx, deps, request, idempotencyKey, result);
      return { kind: 'done' as const, result };
    }

    const startedAt = deps.clock.now().getTime();
    await tx.enqueueAudit(
      adsAuditEvent({
        action: 'metrics.fetch_started',
        outcome: 'success',
        traceId: request.traceId,
        workspaceId: request.workspaceId,
        userId: request.userId,
        goalId: request.goalId,
        campaignId: campaign.probaCampaignId,
        clock: deps.clock,
        details: {
          verb: METRICS_FETCH_VERB,
          platform: 'reddit',
          periodStart: request.periodStart,
          periodEnd: request.periodEnd,
          granularity: window.granularity,
          providerCampaignId: campaign.providerCampaignId,
        },
      })
    );
    await tx.markInFlight(request.workspaceId, idempotencyKey, campaign.probaCampaignId);
    return { kind: 'dispatch' as const, campaign, startedAt };
  });

  if (prepared.kind === 'replay' || prepared.kind === 'done') return prepared.result;

  const { campaign, startedAt } = prepared;
  const query: MetricsFetchQuery = {
    workspaceId: request.workspaceId,
    userId: request.userId,
    initiatedBy: request.initiatedBy ?? 'user',
    probaCampaignId: campaign.probaCampaignId,
    providerAccountId: campaign.providerAccountId!,
    providerCampaignId: campaign.providerCampaignId!,
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
    granularity: window.granularity,
    timezone: window.timezone,
    fetchedAt: deps.clock.isoNow(),
    reportMaxPages:
      deps.config.reddit.enabled && deps.config.reddit.reportMaxPages
        ? deps.config.reddit.reportMaxPages
        : REDDIT_REPORT_DEFAULT_MAX_PAGES,
  };

  const outcome = await deps.provider.fetchCampaignMetrics(query);
  const durationMs = Math.max(0, deps.clock.now().getTime() - startedAt);
  const actor = attributionDetails(request.initiatedBy, outcome.attribution);

  return deps.store.withTransaction(async (tx) => {
    if (outcome.kind === 'unconfigured') {
      const result = fail('provider_unconfigured', outcome.message);
      await completeFailed(tx, deps, request, idempotencyKey, campaign, result, durationMs, actor);
      return result;
    }
    if (outcome.kind === 'refused') {
      const result = fail(outcome.code, outcome.message);
      await completeFailed(tx, deps, request, idempotencyKey, campaign, result, durationMs, actor);
      return result;
    }

    const ingested = outcome.observations.length;
    const quarantined = outcome.quarantined.length;
    const result: AdsDomainResult = {
      ok: true,
      data: {
        probaCampaignId: campaign.probaCampaignId,
        platform: 'reddit',
        ingested,
        quarantined,
        pages: outcome.pages,
        periodStart: request.periodStart,
        periodEnd: request.periodEnd,
        granularity: window.granularity,
        timezone: window.timezone,
        observations: outcome.observations,
        quarantinedRows: outcome.quarantined,
        campaignMutated: false,
      },
    };

    await tx.completeCommand({
      workspaceId: request.workspaceId,
      idempotencyKey,
      status: 'succeeded',
      result,
      campaignId: campaign.probaCampaignId,
    });

    for (const observation of outcome.observations) {
      await tx.enqueueAudit(
        adsAuditEvent({
          action: 'metrics.ingested',
          outcome: 'success',
          traceId: request.traceId,
          workspaceId: request.workspaceId,
          userId: request.userId,
          goalId: request.goalId,
          campaignId: campaign.probaCampaignId,
          clock: deps.clock,
          details: {
            platform: observation.platform,
            accountId: observation.accountId,
            campaignId: observation.campaignId,
            granularity: observation.granularity,
            periodStart: observation.periodStart,
            periodEnd: observation.periodEnd,
            impressions: observation.metrics.impressions,
            clicks: observation.metrics.clicks,
            spend: observation.metrics.spend,
            conversions: observation.metrics.conversions,
            currency: observation.currency,
            revision: observation.revision,
            sourceRef: observation.sourceRef,
            observations: [observation],
          },
        })
      );
    }

    await tx.enqueueAudit(
      adsAuditEvent({
        action: 'campaign.metrics_attributed',
        outcome: quarantined > 0 && ingested > 0 ? 'partial' : ingested > 0 ? 'success' : quarantined > 0 ? 'partial' : 'success',
        traceId: request.traceId,
        workspaceId: request.workspaceId,
        userId: request.userId,
        goalId: request.goalId,
        campaignId: campaign.probaCampaignId,
        clock: deps.clock,
        details: {
          platform: 'reddit',
          periodStart: request.periodStart,
          periodEnd: request.periodEnd,
          observationCount: ingested,
          quarantinedCount: quarantined,
          pages: outcome.pages,
          ...actor,
        },
      })
    );
    await tx.enqueueAudit(
      adsAuditEvent({
        action: 'metrics.fetch_completed',
        outcome: quarantined > 0 && ingested > 0 ? 'partial' : 'success',
        traceId: request.traceId,
        workspaceId: request.workspaceId,
        userId: request.userId,
        goalId: request.goalId,
        campaignId: campaign.probaCampaignId,
        clock: deps.clock,
        details: {
          verb: METRICS_FETCH_VERB,
          platform: 'reddit',
          ingested,
          quarantined,
          pages: outcome.pages,
          durationMs,
          campaignMutated: false,
          ...actor,
        },
      })
    );
    await tx.enqueueAudit(
      adsAuditEvent({
        action: 'command.processed',
        outcome: 'success',
        traceId: request.traceId,
        workspaceId: request.workspaceId,
        userId: request.userId,
        campaignId: campaign.probaCampaignId,
        clock: deps.clock,
        details: { verb: METRICS_FETCH_VERB, ingested, quarantined },
      })
    );
    return result;
  });
}

async function finishRejected(
  tx: AdsTx,
  deps: AnalyticsDeps,
  request: MetricsFetchRequest,
  idempotencyKey: string,
  result: AdsDomainResult
): Promise<void> {
  await tx.completeCommand({
    workspaceId: request.workspaceId,
    idempotencyKey,
    status: 'failed',
    result,
  });
  await tx.enqueueAudit(
    adsAuditEvent({
      action: 'command.rejected',
      outcome: 'failure',
      traceId: request.traceId,
      workspaceId: request.workspaceId,
      userId: request.userId,
      clock: deps.clock,
      errorCode: result.ok ? undefined : result.code,
      details: { verb: METRICS_FETCH_VERB },
    })
  );
}

async function completeFailed(
  tx: AdsTx,
  deps: AnalyticsDeps,
  request: MetricsFetchRequest,
  idempotencyKey: string,
  campaign: CampaignRecord,
  result: Extract<AdsDomainResult, { ok: false }>,
  durationMs: number,
  actor: Record<string, unknown> = {}
): Promise<void> {
  await tx.completeCommand({
    workspaceId: request.workspaceId,
    idempotencyKey,
    status: 'failed',
    result,
    campaignId: campaign.probaCampaignId,
  });
  await tx.enqueueAudit(
    adsAuditEvent({
      action: 'metrics.fetch_failed',
      outcome: 'failure',
      traceId: request.traceId,
      workspaceId: request.workspaceId,
      userId: request.userId,
      campaignId: campaign.probaCampaignId,
      clock: deps.clock,
      errorCode: result.code,
      details: { verb: METRICS_FETCH_VERB, durationMs, campaignMutated: false, ...actor },
    })
  );
}
