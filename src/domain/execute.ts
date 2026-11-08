import { randomUUID } from 'node:crypto';
import {
  AmbiguousOutcomeError,
  BillingNotReadyError,
  DomainRefusedError,
  IdempotencyConflictError,
  OwnershipError,
  ProviderUnconfiguredError,
  RequestValidationError,
  StaleVersionError,
  WorkspaceScopeError,
} from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { VerifiedCaller } from '../ports/auth.js';
import type { ProviderAdapter, ProviderMapping } from '../providers/port.js';
import type { AdsStore, AdsTx, CampaignRecord, CommandRecord } from '../store/port.js';
import { requestFingerprint } from '../store/fingerprint.js';
import type { AdsServiceConfig } from '../types/config.js';
import type { AdsDomainResult, CampaignActionRequest } from '../types/http.js';
import { adsAuditEvent } from '../audit/emit.js';
import { evaluateBillingGate } from './billing.js';
import { parseVerbArgs, spendClassFor, type ParsedAdsArgs } from './verbs.js';

export interface ExecuteDeps {
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

function mappingOf(row: CampaignRecord, mapping?: ProviderMapping): AdsDomainResult {
  const scaffold = mapping?.launchKind === 'campaign_ad_group_scaffold' || mapping?.deliverableAd === false;
  return {
    ok: true,
    data: {
      probaCampaignId: row.probaCampaignId,
      version: row.version,
      landingPageUrl: row.landingPageUrl,
      mappings:
        row.provider && row.providerCampaignId
          ? [
              {
                probaCampaignId: row.probaCampaignId,
                provider: row.provider,
                providerCampaignId: row.providerCampaignId,
                providerAdGroupId: row.providerAdGroupId,
                providerAdId: row.providerAdId,
              },
            ]
          : [],
      ...(scaffold
        ? {
            providerLaunch: 'campaign_ad_group_scaffold',
            deliverableAd: false,
            clickUrlPushed: false,
            missingProviderEntities: mapping?.missingEntities ?? ['ad', 'creative', 'click_url'],
          }
        : {}),
    },
  };
}

async function requireAccount(tx: AdsTx, workspaceId: string, args: ParsedAdsArgs, platform: CampaignRecord['platform']) {
  const accounts = await tx.listAccounts(workspaceId, platform);
  if (accounts.length === 0) {
    throw new OwnershipError('no provider account is mapped for this workspace and platform');
  }
  if (args.providerAccountId && !accounts.some((a) => a.accountId === args.providerAccountId && a.status === 'ready')) {
    throw new OwnershipError('providerAccountId does not match a ready account mapping for this workspace');
  }
  const ready = accounts.filter((a) => a.status === 'ready');
  if (ready.length === 0) {
    throw new OwnershipError('provider account mapping exists but is not ready');
  }
  if (!args.providerAccountId && ready.length > 1) {
    throw new OwnershipError('multiple provider accounts are mapped; pass the exact account for this campaign');
  }
  return ready[0]!;
}

interface PreparedCommand {
  campaign: CampaignRecord;
  args: ParsedAdsArgs;
  providerAccountId?: string;
}

const inProcessClaims = new Map<string, Promise<AdsDomainResult>>();

export async function executeCampaignAction(
  deps: ExecuteDeps,
  request: CampaignActionRequest,
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

async function executeOnce(
  deps: ExecuteDeps,
  request: CampaignActionRequest,
  caller: VerifiedCaller,
  idempotencyKey: string
): Promise<AdsDomainResult> {
  if (caller.workspaceId && caller.workspaceId !== request.workspaceId) {
    throw new WorkspaceScopeError();
  }
  const args = parseVerbArgs(request.verb, request.args);
  const spendClass = spendClassFor(args.verb, request.args);
  const fingerprint = requestFingerprint(args.verb, request.args);

  const prepared = await deps.store.withTransaction(async (tx) => {
    const claim = await tx.claimCommand({
      workspaceId: request.workspaceId,
      idempotencyKey,
      fingerprint,
      verb: args.verb,
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
            details: { verb: args.verb, reason: 'idempotency key reused with different args' },
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
          details: { verb: args.verb, status: claim.record.status },
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
        details: { verb: args.verb, spendClass, decisionId: request.decisionId, commandId: request.commandId },
      })
    );

    if (!deps.provider.configured) {
      const result = fail(
        'provider_unconfigured',
        'No provider adapter is configured. The command was not applied as a provider mutation and success is not claimed.'
      );
      await finishRejected(tx, deps, request, idempotencyKey, args, result);
      return { kind: 'done' as const, result };
    }

    const billed = await deps.provider.billingClaim(request.workspaceId, args.platform);
    const gate = evaluateBillingGate({
      claim: billed,
      spendClass,
      dailyBudget: args.dailyBudget,
      currency: args.currency,
      config: deps.config,
    });
    if (!gate.ok) {
      const result = fail('billing_not_ready', gate.message ?? 'billing is not ready');
      await finishRejected(tx, deps, request, idempotencyKey, args, result);
      return { kind: 'done' as const, result };
    }

    let campaign: CampaignRecord;
    try {
      if (args.verb === 'ads.create_campaign') {
        const account = await requireAccount(tx, request.workspaceId, args, args.platform!);
        campaign = {
          workspaceId: request.workspaceId,
          probaCampaignId: randomUUID(),
          userId: request.userId,
          goalId: request.goalId,
          name: args.name!,
          landingPageUrl: args.landingPageUrl!,
          dailyBudget: args.dailyBudget!,
          currency: args.currency!,
          platform: args.platform!,
          status: 'draft',
          version: 1,
          lockCommandKey: idempotencyKey,
          providerAccountId: account.accountId,
        };
        await tx.insertCampaign(campaign);
      } else {
        const existing = await tx.lockCampaign(request.workspaceId, args.probaCampaignId!);
        if (!existing) throw new OwnershipError('campaign is not in this workspace');
        if (existing.userId !== request.userId) throw new OwnershipError('campaign is not owned by this user');
        if (existing.lockCommandKey && existing.lockCommandKey !== idempotencyKey) {
          throw new DomainRefusedError('campaign_busy', 'another command holds this campaign; not retrying a side effect');
        }
        if (args.expectedVersion !== undefined && existing.version !== args.expectedVersion) {
          throw new StaleVersionError();
        }
        if (args.providerAccountId && existing.providerAccountId && args.providerAccountId !== existing.providerAccountId) {
          throw new OwnershipError('command targets a different provider account than this campaign mapping');
        }
        campaign = existing;
      }
    } catch (err) {
      const result = domainFail(err);
      await finishRejected(tx, deps, request, idempotencyKey, args, result);
      return { kind: 'done' as const, result };
    }

    await tx.enqueueAudit(
      adsAuditEvent({
        action: 'command.accepted',
        outcome: 'success',
        traceId: request.traceId,
        workspaceId: request.workspaceId,
        userId: request.userId,
        goalId: request.goalId,
        campaignId: campaign.probaCampaignId,
        clock: deps.clock,
        details: { verb: args.verb, version: campaign.version },
      })
    );
    await tx.markInFlight(request.workspaceId, idempotencyKey, campaign.probaCampaignId);
    return {
      kind: 'dispatch' as const,
      prepared: { campaign, args, providerAccountId: campaign.providerAccountId } satisfies PreparedCommand,
    };
  });

  if (prepared.kind === 'replay' || prepared.kind === 'done') return prepared.result;

  const { campaign, args: parsed } = prepared.prepared;
  const outcome = await deps.provider.mutate({
    workspaceId: request.workspaceId,
    userId: request.userId,
    verb: parsed.verb,
    args: parsed,
    platform: campaign.platform,
    probaCampaignId: campaign.probaCampaignId,
    landingPageUrl: parsed.landingPageUrl ?? campaign.landingPageUrl,
    providerAccountId: prepared.prepared.providerAccountId ?? campaign.providerAccountId,
    providerCampaignId: campaign.providerCampaignId,
    providerAdGroupId: campaign.providerAdGroupId,
  });

  return deps.store.withTransaction(async (tx) => {
    const current = await tx.lockCampaign(request.workspaceId, campaign.probaCampaignId);
    if (!current) {
      const result = fail('outcome_ambiguous', 'campaign disappeared after provider dispatch; not retried');
      await tx.completeCommand({
        workspaceId: request.workspaceId,
        idempotencyKey,
        status: 'ambiguous',
        result,
        campaignId: campaign.probaCampaignId,
      });
      throw new AmbiguousOutcomeError(result.message);
    }

    if (outcome.kind === 'unconfigured') {
      const result = fail('provider_unconfigured', outcome.message);
      await tx.completeCommand({
        workspaceId: request.workspaceId,
        idempotencyKey,
        status: 'failed',
        result,
        campaignId: current.probaCampaignId,
      });
      return result;
    }

    if (outcome.kind === 'ambiguous') {
      const updated = await tx.updateCampaignCas(request.workspaceId, current.probaCampaignId, current.version, {
        status: 'ambiguous',
        lockCommandKey: null,
        reconcile: { reason: outcome.message, at: deps.clock.isoNow(), verb: parsed.verb },
      });
      if (!updated) throw new StaleVersionError();
      const result = fail('outcome_ambiguous', outcome.message);
      await tx.completeCommand({
        workspaceId: request.workspaceId,
        idempotencyKey,
        status: 'ambiguous',
        result,
        campaignId: current.probaCampaignId,
      });
      await tx.enqueueAudit(
        adsAuditEvent({
          action: 'campaign.sync_failed',
          outcome: 'failure',
          traceId: request.traceId,
          workspaceId: request.workspaceId,
          userId: request.userId,
          campaignId: current.probaCampaignId,
          clock: deps.clock,
          errorCode: 'outcome_ambiguous',
          details: { verb: parsed.verb, note: 'uncertain outcome persisted; command will not be replayed' },
        })
      );
      throw new AmbiguousOutcomeError(outcome.message);
    }

    if (outcome.kind === 'refused') {
      const result = fail(outcome.code, outcome.message);
      await tx.updateCampaignCas(request.workspaceId, current.probaCampaignId, current.version, {
        lockCommandKey: null,
        status: current.status,
      });
      await tx.completeCommand({
        workspaceId: request.workspaceId,
        idempotencyKey,
        status: 'failed',
        result,
        campaignId: current.probaCampaignId,
      });
      return result;
    }

    const scaffoldOnly =
      parsed.verb === 'ads.create_campaign' &&
      (outcome.mapping.launchKind === 'campaign_ad_group_scaffold' || outcome.mapping.deliverableAd === false);
    const nextStatus =
      parsed.verb === 'ads.pause_campaign' ? 'paused' : scaffoldOnly ? 'draft' : 'active';
    const campaignAction =
      parsed.verb === 'ads.create_campaign'
        ? 'campaign.created'
        : parsed.verb === 'ads.pause_campaign'
          ? 'campaign.paused'
          : parsed.verb === 'ads.resume_campaign'
            ? 'campaign.resumed'
            : parsed.dailyBudget !== undefined
              ? 'campaign.budget_changed'
              : 'campaign.synced';

    const updated = await tx.updateCampaignCas(request.workspaceId, current.probaCampaignId, current.version, {
      name: parsed.name ?? current.name,
      landingPageUrl: parsed.landingPageUrl ?? current.landingPageUrl,
      dailyBudget: parsed.dailyBudget ?? current.dailyBudget,
      status: nextStatus,
      lockCommandKey: null,
      provider: outcome.mapping.provider,
      providerAccountId: outcome.mapping.providerAccountId,
      providerCampaignId: outcome.mapping.providerCampaignId,
      providerAdGroupId: outcome.mapping.providerAdGroupId,
      providerAdId: outcome.mapping.providerAdId,
      reconcile: null,
    });
    if (!updated) throw new StaleVersionError();
    const result = mappingOf(updated, outcome.mapping);
    await tx.completeCommand({
      workspaceId: request.workspaceId,
      idempotencyKey,
      status: 'succeeded',
      result,
      campaignId: updated.probaCampaignId,
    });
    await tx.enqueueAudit(
      adsAuditEvent({
        action: campaignAction,
        outcome: 'success',
        traceId: request.traceId,
        workspaceId: request.workspaceId,
        userId: request.userId,
        goalId: request.goalId,
        campaignId: updated.probaCampaignId,
        clock: deps.clock,
        details: {
          verb: parsed.verb,
          version: updated.version,
          platform: updated.platform,
          landingPageUrlLength: updated.landingPageUrl.length,
          ...(scaffoldOnly
            ? {
                providerLaunch: 'campaign_ad_group_scaffold',
                deliverableAd: false,
                clickUrlPushed: false,
              }
            : {}),
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
        campaignId: updated.probaCampaignId,
        clock: deps.clock,
        details: { verb: parsed.verb, version: updated.version },
      })
    );
    return result;
  });
}

async function finishRejected(
  tx: AdsTx,
  deps: ExecuteDeps,
  request: CampaignActionRequest,
  idempotencyKey: string,
  args: ParsedAdsArgs,
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
      details: { verb: args.verb },
    })
  );
}

function domainFail(err: unknown): AdsDomainResult {
  if (
    err instanceof BillingNotReadyError ||
    err instanceof OwnershipError ||
    err instanceof StaleVersionError ||
    err instanceof RequestValidationError ||
    err instanceof DomainRefusedError ||
    err instanceof ProviderUnconfiguredError
  ) {
    return fail(err.code, err.message);
  }
  return fail('command_failed', err instanceof Error ? err.message : 'command failed');
}
