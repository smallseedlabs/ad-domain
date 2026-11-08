import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryAuditPublisher } from '../audit/publisher.js';
import { ServiceTokenAuth } from '../auth/service-token.js';
import { SystemClock } from '../ports/clock.js';
import { UnconfiguredProvider } from '../providers/unconfigured.js';
import { MemoryStore } from '../store/memory.js';
import {
  testConfig,
  fixtureCreateArgs,
  FIXTURE_GOAL_ID,
  FIXTURE_LANDING_PAGE_URL,
  FIXTURE_TRACE_ID,
  FIXTURE_USER_ID,
  FIXTURE_WORKSPACE,
} from '../testing/config.js';
import { createTestSigner, mintGatewayToken } from '../testing/token-signer.js';
import { buildApp } from './app.js';
import { createLogger } from '../logger.js';

async function harness() {
  const signer = await createTestSigner();
  const store = new MemoryStore();
  const audit = new MemoryAuditPublisher();
  const app = await buildApp({
    config: testConfig(),
    auth: new ServiceTokenAuth({
      keys: signer.keys,
      allowedIssuers: ['proba-gateway'],
      allowedSubjects: ['gateway'],
    }),
    audit,
    clock: new SystemClock(),
    logger: createLogger('silent'),
    store,
    provider: new UnconfiguredProvider(),
  });
  return { app, signer, store, audit };
}

describe('HTTP contract [fake-store] [unit]', () => {
  it('rejects unauthorized campaign actions before work', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'POST', url: '/v1/campaign-actions', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });

  it('/health is not a billing claim and /ready does not report billing', async () => {
    const { app } = await harness();
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', service: 'ads' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.billing).toBeUndefined();
  });

  it('preflight reports service ready, connection missing, billing unknown when adapters are unconfigured', async () => {
    const { app, signer } = await harness();
    const token = await mintGatewayToken(signer);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/preflight',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspaceId: FIXTURE_WORKSPACE,
        userId: FIXTURE_USER_ID,
        mappingRequired: false,
        verb: 'ads.create_campaign',
        platform: 'reddit',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.service.state).toBe('ready');
    expect(body.connection.state).toBe('missing');
    expect(body.billing.kind).toBe('unknown');
  });

  it('create fails closed without a provider and does not invent a landing page URL', async () => {
    const { app, signer } = await harness();
    const token = await mintGatewayToken(signer);
    const missingUrl = await app.inject({
      method: 'POST',
      url: '/v1/campaign-actions',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      payload: {
        traceId: FIXTURE_TRACE_ID,
        workspaceId: FIXTURE_WORKSPACE,
        userId: FIXTURE_USER_ID,
        verb: 'ads.create_campaign',
        args: { name: 'x', dailyBudget: 10, currency: 'USD', platform: 'reddit' },
      },
    });
    expect(missingUrl.statusCode).toBe(400);

    const incompleteLaunch = await app.inject({
      method: 'POST',
      url: '/v1/campaign-actions',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      payload: {
        traceId: FIXTURE_TRACE_ID,
        workspaceId: FIXTURE_WORKSPACE,
        userId: FIXTURE_USER_ID,
        verb: 'ads.create_campaign',
        args: {
          name: 'x',
          landingPageUrl: FIXTURE_LANDING_PAGE_URL,
          dailyBudget: 10,
          currency: 'USD',
          platform: 'reddit',
        },
      },
    });
    expect(incompleteLaunch.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/campaign-actions',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      payload: {
        traceId: FIXTURE_TRACE_ID,
        workspaceId: FIXTURE_WORKSPACE,
        userId: FIXTURE_USER_ID,
        goalId: FIXTURE_GOAL_ID,
        verb: 'ads.create_campaign',
        args: fixtureCreateArgs({ name: 'x', dailyBudget: 10 }),
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ ok: false, code: 'provider_unconfigured' });
  });

  it('rejects unauthorized metrics fetch before work', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'POST', url: '/v1/metrics-fetch', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('metrics-fetch fails closed without a provider and does not mutate campaigns', async () => {
    const { app, signer, store } = await harness();
    const token = await mintGatewayToken(signer);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/metrics-fetch',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      payload: {
        traceId: FIXTURE_TRACE_ID,
        workspaceId: FIXTURE_WORKSPACE,
        userId: FIXTURE_USER_ID,
        probaCampaignId: randomUUID(),
        periodStart: '2026-11-01T00:00:00.000Z',
        periodEnd: '2026-11-02T00:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, code: 'provider_unconfigured' });
    expect(store.campaigns.size).toBe(0);
  });

  it('rejects a workspace-scoped token that does not match the body', async () => {
    const { app, signer } = await harness();
    const token = await mintGatewayToken(signer, () => new Date(), { workspaceId: 'other' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign-actions',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      payload: {
        traceId: FIXTURE_TRACE_ID,
        workspaceId: FIXTURE_WORKSPACE,
        userId: FIXTURE_USER_ID,
        verb: 'ads.pause_campaign',
        args: { probaCampaignId: randomUUID() },
      },
    });
    expect(res.statusCode).toBe(403);
  });
});
