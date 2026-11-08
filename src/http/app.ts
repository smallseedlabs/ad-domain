import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  AmbiguousOutcomeError,
  IdentityRejectedError,
  IdempotencyConflictError,
  RequestValidationError,
  WorkspaceScopeError,
} from '../errors.js';
import type { ServiceAuth, VerifiedCaller } from '../ports/auth.js';
import type { Logger } from '../logger.js';
import { adsAuditEvent } from '../audit/emit.js';
import type { AuditPublisher } from '../ports/audit-publisher.js';
import { ADS_SERVICE_NAME } from '../types/config.js';
import { campaignActionRequestSchema, metricsFetchRequestSchema, preflightRequestSchema, type AdsDomainResult } from '../types/http.js';
import { executeCampaignAction, type ExecuteDeps } from '../domain/execute.js';
import { executeMetricsFetch } from '../domain/analytics.js';
import { buildPreflightReport } from '../domain/preflight.js';
import { adsPreflightReportSchema } from '../types/preflight.js';
import { SlidingWindowRateLimiter } from './rate-limit.js';

export const SERVICE_NAME = ADS_SERVICE_NAME;

export interface AppDeps extends ExecuteDeps {
  auth: ServiceAuth;
  audit: AuditPublisher;
  logger: Logger;
  ready?: () => Promise<Record<string, 'ok' | 'fail'>>;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function errorBody(code: string, message: string): { error: string; message: string } {
  return { error: code, message };
}

async function deny(
  deps: AppDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  workspaceId = 'unknown'
): Promise<FastifyReply> {
  try {
    await deps.audit.publish(
      adsAuditEvent({
        action: 'auth.denied',
        outcome: 'denied',
        traceId: '00000000-0000-4000-8000-000000000000',
        workspaceId,
        clock: deps.clock,
        errorCode: code,
        details: { path: request.url, method: request.method },
      })
    );
  } catch {
    // Fail closed on the request; do not log token material.
  }
  return reply.status(status).send(errorBody(code, message));
}

async function authenticate(deps: AppDeps, request: FastifyRequest, reply: FastifyReply): Promise<VerifiedCaller | FastifyReply> {
  try {
    return await deps.auth.authenticate({ authorization: header(request, 'authorization') });
  } catch (err) {
    if (err instanceof IdentityRejectedError) {
      return deny(deps, request, reply, 401, err.code, 'service token was rejected');
    }
    deps.logger.error({ err: err instanceof Error ? err.name : 'error' }, 'auth verifier unavailable');
    return reply.status(503).send(errorBody('auth_unavailable', 'caller verification unavailable'));
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const limiter = new SlidingWindowRateLimiter(deps.config.limits.rateLimitMax, deps.config.limits.rateLimitWindowMs);
  const app = Fastify({
    logger: false,
    bodyLimit: deps.config.limits.maxRequestBytes,
    trustProxy: false,
  });

  app.get('/health', async () => ({ status: 'ok', service: SERVICE_NAME }));

  app.get('/ready', async (_request, reply) => {
    const checks = deps.ready ? await deps.ready() : { config: 'ok' as const };
    const ready = Object.values(checks).every((v) => v === 'ok');
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      service: SERVICE_NAME,
      checks,
    });
  });

  app.post('/v1/preflight', async (request, reply) => {
    const callerOrReply = await authenticate(deps, request, reply);
    if (!('issuer' in callerOrReply)) return callerOrReply;
    const caller = callerOrReply;
    if (!limiter.allow(`${caller.issuer}\n${caller.subject}`)) {
      return reply.status(429).send(errorBody('rate_limited', 'caller exceeded the request rate limit'));
    }
    const parsed = preflightRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(errorBody('invalid_request', parsed.error.issues[0]?.message ?? 'invalid request'));
    }
    if (caller.workspaceId && caller.workspaceId !== parsed.data.workspaceId) {
      return deny(deps, request, reply, 403, 'workspace_mismatch', 'workspace in the body does not match the caller identity', parsed.data.workspaceId);
    }
    const report = await buildPreflightReport({
      config: deps.config,
      store: deps.store,
      provider: deps.provider,
      clock: deps.clock,
      query: parsed.data,
    });
    const checked = adsPreflightReportSchema.safeParse(report);
    if (!checked.success) {
      return reply.status(500).send(errorBody('invalid_response', 'preflight report failed contract validation'));
    }
    return reply.status(200).send(checked.data);
  });

  app.post('/v1/campaign-actions', async (request, reply) => {
    const callerOrReply = await authenticate(deps, request, reply);
    if (!('issuer' in callerOrReply)) return callerOrReply;
    const caller = callerOrReply;
    if (!limiter.allow(`${caller.issuer}\n${caller.subject}`)) {
      return reply.status(429).send(errorBody('rate_limited', 'caller exceeded the request rate limit'));
    }
    const parsed = campaignActionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(errorBody('invalid_request', parsed.error.issues[0]?.message ?? 'invalid request'));
    }
    const body = parsed.data;
    const headerKey = header(request, 'idempotency-key');
    const idempotencyKey = headerKey ?? body.idempotencyKey;
    if (!idempotencyKey) {
      return reply.status(400).send(errorBody('invalid_request', 'Idempotency-Key is required'));
    }
    if (body.idempotencyKey && body.idempotencyKey !== idempotencyKey) {
      return reply.status(400).send(errorBody('invalid_request', 'Idempotency-Key header does not match body.idempotencyKey'));
    }
    try {
      const result: AdsDomainResult = await executeCampaignAction(deps, body, caller, idempotencyKey);
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof RequestValidationError) {
        return reply.status(400).send(errorBody(err.code, err.message));
      }
      if (err instanceof WorkspaceScopeError) {
        return deny(deps, request, reply, 403, err.code, err.message, body.workspaceId);
      }
      if (err instanceof IdempotencyConflictError) {
        return reply.status(409).send(errorBody(err.code, err.message));
      }
      if (err instanceof AmbiguousOutcomeError) {
        return reply.status(200).send({ ok: false, code: err.code, message: err.message } satisfies AdsDomainResult);
      }
      deps.logger.error({ err: err instanceof Error ? err.name : 'error', traceId: body.traceId }, 'campaign action failed');
      return reply.status(500).send(errorBody('internal', 'internal error'));
    }
  });

  app.post('/v1/metrics-fetch', async (request, reply) => {
    const callerOrReply = await authenticate(deps, request, reply);
    if (!('issuer' in callerOrReply)) return callerOrReply;
    const caller = callerOrReply;
    if (!limiter.allow(`${caller.issuer}\n${caller.subject}`)) {
      return reply.status(429).send(errorBody('rate_limited', 'caller exceeded the request rate limit'));
    }
    const parsed = metricsFetchRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(errorBody('invalid_request', parsed.error.issues[0]?.message ?? 'invalid request'));
    }
    const body = parsed.data;
    const headerKey = header(request, 'idempotency-key');
    const idempotencyKey = headerKey ?? body.idempotencyKey;
    if (!idempotencyKey) {
      return reply.status(400).send(errorBody('invalid_request', 'Idempotency-Key is required'));
    }
    if (body.idempotencyKey && body.idempotencyKey !== idempotencyKey) {
      return reply.status(400).send(errorBody('invalid_request', 'Idempotency-Key header does not match body.idempotencyKey'));
    }
    try {
      const result: AdsDomainResult = await executeMetricsFetch(deps, body, caller, idempotencyKey);
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof RequestValidationError) {
        return reply.status(400).send(errorBody(err.code, err.message));
      }
      if (err instanceof WorkspaceScopeError) {
        return deny(deps, request, reply, 403, err.code, err.message, body.workspaceId);
      }
      if (err instanceof IdempotencyConflictError) {
        return reply.status(409).send(errorBody(err.code, err.message));
      }
      if (err instanceof AmbiguousOutcomeError) {
        return reply.status(200).send({ ok: false, code: err.code, message: err.message } satisfies AdsDomainResult);
      }
      deps.logger.error({ err: err instanceof Error ? err.name : 'error', traceId: body.traceId }, 'metrics fetch failed');
      return reply.status(500).send(errorBody('internal', 'internal error'));
    }
  });

  return app;
}
