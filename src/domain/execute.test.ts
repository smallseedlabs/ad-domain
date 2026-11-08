import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AmbiguousOutcomeError,
  IdempotencyConflictError,
  RequestValidationError,
  WorkspaceScopeError,
} from '../errors.js';
import { SystemClock } from '../ports/clock.js';
import { FakeProvider, eligibleBillingClaim } from '../providers/fake.js';
import { UnconfiguredProvider } from '../providers/unconfigured.js';
import { MemoryStore } from '../store/memory.js';
import {
  testConfig,
  FIXTURE_GOAL_ID,
  FIXTURE_LANDING_PAGE_URL,
  FIXTURE_PROVIDER_POST_ID,
  FIXTURE_RESEARCH_ACCEPTANCE,
  FIXTURE_TRACE_ID,
  FIXTURE_USER_ID,
  FIXTURE_WORKSPACE,
} from '../testing/config.js';
import type { CampaignActionRequest } from '../types/http.js';
import { executeCampaignAction } from './execute.js';

function caller(workspaceId?: string) {
  return {
    issuer: 'proba-gateway',
    subject: 'gateway',
    jti: randomUUID(),
    keyId: 'k',
    expiresAt: new Date(Date.now() + 60_000),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

function createReq(overrides: Partial<CampaignActionRequest> = {}, args: Record<string, unknown> = {}): CampaignActionRequest {
  return {
    traceId: FIXTURE_TRACE_ID,
    workspaceId: FIXTURE_WORKSPACE,
    userId: FIXTURE_USER_ID,
    verb: 'ads.create_campaign',
    goalId: FIXTURE_GOAL_ID,
    args: {
      name: 'test campaign',
      landingPageUrl: FIXTURE_LANDING_PAGE_URL,
      dailyBudget: 15,
      currency: 'USD',
      platform: 'reddit',
      providerPostId: FIXTURE_PROVIDER_POST_ID,
      researchAcceptance: FIXTURE_RESEARCH_ACCEPTANCE,
      ...args,
    },
    ...overrides,
  };
}

describe('executeCampaignAction [fake-store]', () => {
  it('refuses create without a goalId and does not invent one', async () => {
    await expect(
      executeCampaignAction(
        { config: testConfig(), store: new MemoryStore(), provider: new UnconfiguredProvider(), clock: new SystemClock() },
        createReq({ goalId: undefined }),
        caller(),
        randomUUID()
      )
    ).rejects.toBeInstanceOf(RequestValidationError);
  });

  it('fails closed when the provider adapter is unconfigured and does not claim success', async () => {
    const store = new MemoryStore();
    const result = await executeCampaignAction(
      { config: testConfig(), store, provider: new UnconfiguredProvider(), clock: new SystemClock() },
      createReq(),
      caller(),
      randomUUID()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('provider_unconfigured');
    expect(store.campaigns.size).toBe(0);
  });

  it('rejects a token-scoped workspace that does not match the body', async () => {
    await expect(
      executeCampaignAction(
        { config: testConfig(), store: new MemoryStore(), provider: new UnconfiguredProvider(), clock: new SystemClock() },
        createReq(),
        caller('other-workspace'),
        randomUUID()
      )
    ).rejects.toBeInstanceOf(WorkspaceScopeError);
  });

  it('rejects spend-increase when billing is unknown even with a fake adapter [fake-provider]', async () => {
    const fake = new FakeProvider();
    const store = new MemoryStore();
    const result = await executeCampaignAction(
      { config: testConfig(), store, provider: fake, clock: new SystemClock() },
      createReq(),
      caller(),
      randomUUID()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('billing_not_ready');
  });

  it('rejects wrong provider account mapping [fake-provider]', async () => {
    const fake = new FakeProvider();
    fake.billing = eligibleBillingClaim();
    const store = new MemoryStore();
    await store.withTransaction((tx) =>
      tx.upsertAccount({ workspaceId: FIXTURE_WORKSPACE, platform: 'reddit', accountId: 'acct-a', status: 'ready' })
    );
    const result = await executeCampaignAction(
      { config: testConfig(), store, provider: fake, clock: new SystemClock() },
      createReq({}, { providerAccountId: 'acct-other' }),
      caller(),
      randomUUID()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ownership_mismatch');
  });

  it('creates with fake provider when billing is eligible and mapping exists, preserving landingPageUrl [fake-provider]', async () => {
    const fake = new FakeProvider();
    fake.billing = eligibleBillingClaim();
    const store = new MemoryStore();
    await store.withTransaction((tx) =>
      tx.upsertAccount({ workspaceId: FIXTURE_WORKSPACE, platform: 'reddit', accountId: fake.accountId, status: 'ready' })
    );
    const result = await executeCampaignAction(
      { config: testConfig(), store, provider: fake, clock: new SystemClock() },
      createReq(),
      caller(),
      randomUUID()
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.landingPageUrl).toBe(FIXTURE_LANDING_PAGE_URL);
      expect(result.data.probaCampaignId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.data.providerLaunch).toBeUndefined();
      expect(result.data.deliverableAd).toBeUndefined();
    }
  });

  it('replays the same idempotency key and rejects different args', async () => {
    const fake = new FakeProvider();
    fake.billing = eligibleBillingClaim();
    const store = new MemoryStore();
    await store.withTransaction((tx) =>
      tx.upsertAccount({ workspaceId: FIXTURE_WORKSPACE, platform: 'reddit', accountId: fake.accountId, status: 'ready' })
    );
    const key = randomUUID();
    const deps = { config: testConfig(), store, provider: fake, clock: new SystemClock() };
    const first = await executeCampaignAction(deps, createReq(), caller(), key);
    const second = await executeCampaignAction(deps, createReq(), caller(), key);
    expect(first).toEqual(second);
    await expect(
      executeCampaignAction(deps, createReq({}, { name: 'other' }), caller(), key)
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('does not retry an in-flight/ambiguous command', async () => {
    const fake = new FakeProvider();
    fake.billing = eligibleBillingClaim();
    const store = new MemoryStore();
    await store.withTransaction((tx) =>
      tx.upsertAccount({ workspaceId: FIXTURE_WORKSPACE, platform: 'reddit', accountId: fake.accountId, status: 'ready' })
    );
    const key = randomUUID();
    const deps = { config: testConfig(), store, provider: fake, clock: new SystemClock() };
    await executeCampaignAction(deps, createReq(), caller(), key);
    store.forceCommandStatus(FIXTURE_WORKSPACE, key, 'in_flight');
    await expect(executeCampaignAction(deps, createReq(), caller(), key)).rejects.toBeInstanceOf(AmbiguousOutcomeError);
  });

  it('persists ambiguous fake-provider outcomes and refuses a blind retry [fake-provider]', async () => {
    const fake = new FakeProvider();
    fake.billing = eligibleBillingClaim();
    fake.mutateBehavior = 'ambiguous';
    const store = new MemoryStore();
    await store.withTransaction((tx) =>
      tx.upsertAccount({ workspaceId: FIXTURE_WORKSPACE, platform: 'reddit', accountId: fake.accountId, status: 'ready' })
    );
    const key = randomUUID();
    const deps = { config: testConfig(), store, provider: fake, clock: new SystemClock() };
    await expect(executeCampaignAction(deps, createReq(), caller(), key)).rejects.toBeInstanceOf(AmbiguousOutcomeError);
    fake.mutateBehavior = 'success';
    await expect(executeCampaignAction(deps, createReq(), caller(), key)).rejects.toBeInstanceOf(AmbiguousOutcomeError);
  });

  it('rejects pause against a campaign in another workspace', async () => {
    const fake = new FakeProvider();
    fake.billing = eligibleBillingClaim();
    const store = new MemoryStore();
    await store.withTransaction((tx) =>
      tx.upsertAccount({ workspaceId: FIXTURE_WORKSPACE, platform: 'reddit', accountId: fake.accountId, status: 'ready' })
    );
    const created = await executeCampaignAction(
      { config: testConfig(), store, provider: fake, clock: new SystemClock() },
      createReq(),
      caller(),
      randomUUID()
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const paused = await executeCampaignAction(
      { config: testConfig(), store, provider: fake, clock: new SystemClock() },
      {
        traceId: FIXTURE_TRACE_ID,
        workspaceId: 'other-ws',
        userId: FIXTURE_USER_ID,
        verb: 'ads.pause_campaign',
        args: { probaCampaignId: created.data.probaCampaignId },
      },
      caller(),
      randomUUID()
    );
    expect(paused.ok).toBe(false);
    if (!paused.ok) expect(paused.code).toBe('ownership_mismatch');
  });

  it('rejects a stale expectedVersion [fake-provider]', async () => {
    const fake = new FakeProvider();
    fake.billing = eligibleBillingClaim();
    const store = new MemoryStore();
    await store.withTransaction((tx) =>
      tx.upsertAccount({ workspaceId: FIXTURE_WORKSPACE, platform: 'reddit', accountId: fake.accountId, status: 'ready' })
    );
    const created = await executeCampaignAction(
      { config: testConfig(), store, provider: fake, clock: new SystemClock() },
      createReq(),
      caller(),
      randomUUID()
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const stale = await executeCampaignAction(
      { config: testConfig(), store, provider: fake, clock: new SystemClock() },
      {
        traceId: FIXTURE_TRACE_ID,
        workspaceId: FIXTURE_WORKSPACE,
        userId: FIXTURE_USER_ID,
        verb: 'ads.pause_campaign',
        args: { probaCampaignId: created.data.probaCampaignId, expectedVersion: 1 },
      },
      caller(),
      randomUUID()
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('stale_version');
  });

  it('serializes concurrent claims of the same idempotency key [fake-provider]', async () => {
    const fake = new FakeProvider();
    fake.billing = eligibleBillingClaim();
    const store = new MemoryStore();
    await store.withTransaction((tx) =>
      tx.upsertAccount({ workspaceId: FIXTURE_WORKSPACE, platform: 'reddit', accountId: fake.accountId, status: 'ready' })
    );
    const key = randomUUID();
    const deps = { config: testConfig(), store, provider: fake, clock: new SystemClock() };
    const [a, b] = await Promise.all([
      executeCampaignAction(deps, createReq(), caller(), key),
      executeCampaignAction(deps, createReq(), caller(), key),
    ]);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
  });
});
