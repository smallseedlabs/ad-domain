import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SystemClock } from '../ports/clock.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../providers/http.js';
import { CredentialedRedditAdapter } from '../providers/reddit/brokered-adapter.js';
import { REDDIT_ADS_API_BASE } from '../providers/reddit/config.js';
import { BrokerCredentialSource } from '../providers/reddit/credentials.js';
import { ScriptedHttpTransport, type ScriptedStep } from '../providers/scripted-http.js';
import { MemoryStore } from '../store/memory.js';
import {
  fixtureCreateArgs,
  FIXTURE_GOAL_ID,
  FIXTURE_LANDING_PAGE_URL,
  FIXTURE_PROVIDER_POST_ID,
  FIXTURE_PROVIDER_PROFILE_ID,
  FIXTURE_TRACE_ID,
  FIXTURE_USER_ID,
  FIXTURE_WORKSPACE,
  testConfig,
} from '../testing/config.js';
import { executeCampaignAction } from './execute.js';

const CONNECTED = 'a2_connected';
const CONNECTION_ID = '55555555-5555-4555-8555-555555555555';
const CONNECTOR = '66666666-6666-4666-8666-666666666666';
const BROKER_URL = 'http://hub.test:3000';
const BROKER_TOKEN = 'brokered-test-token';

/** Fake broker + scripted Reddit: routes by URL so the test sees both sides. */
class FakeBrokerAndReddit implements HttpTransport {
  readonly brokerCalls: HttpRequest[] = [];
  readonly reddit: ScriptedHttpTransport;
  constructor(
    private readonly broker: Array<{ status: number; body: unknown }>,
    redditSteps: ScriptedStep[]
  ) {
    this.reddit = new ScriptedHttpTransport(redditSteps);
  }
  async request(input: HttpRequest): Promise<HttpResponse> {
    if (input.url.startsWith(BROKER_URL)) {
      this.brokerCalls.push(input);
      const step = this.broker.shift();
      if (!step) throw new Error('fake broker: unexpected call');
      return { status: step.status, headers: {}, bodyText: JSON.stringify(step.body) };
    }
    return this.reddit.request(input);
  }
}

const GRANT = {
  status: 200,
  body: {
    connectionId: CONNECTION_ID,
    provider: 'reddit',
    accountId: CONNECTED,
    accessToken: BROKER_TOKEN,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    connectedBy: CONNECTOR,
    scopes: ['adsread', 'adsedit'],
  },
};

const REDDIT_CREATE: ScriptedStep[] = [
  { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
  { status: 200, body: { data: [{ id: FIXTURE_PROVIDER_PROFILE_ID }], pagination: {} } },
  { status: 201, body: { data: { id: 'job_1', status: 'QUEUED', created_at: '2026-11-08T00:00:00Z', modified_at: '2026-11-08T00:00:00Z' } } },
  {
    status: 200,
    body: {
      data: {
        id: 'job_1',
        status: 'SUCCESS',
        post_id: FIXTURE_PROVIDER_POST_ID,
        error_message: null,
        created_at: '2026-11-08T00:00:00Z',
        modified_at: '2026-11-08T00:00:01Z',
      },
    },
  },
  { status: 200, body: { data: { id: FIXTURE_PROVIDER_POST_ID } } },
  { status: 200, body: { data: [{ id: 'fi_1', is_servable: true, currency: 'USD' }] } },
  { status: 201, body: { data: { id: 'cmp_b', ad_account_id: CONNECTED } } },
  { status: 201, body: { data: { id: 'grp_b' } } },
  { status: 201, body: { data: { id: 'ad_b', click_url: FIXTURE_LANDING_PAGE_URL } } },
];

function provider(http: HttpTransport) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const source = new BrokerCredentialSource(
    { url: BROKER_URL, allowedHosts: ['hub.test:3000'], privateKeyFile: '/unused', keyId: 'ads-svc-1', timeoutMs: 1_000 },
    privateKey,
    http
  );
  return new CredentialedRedditAdapter(
    { apiBaseUrl: REDDIT_ADS_API_BASE, timeoutMs: 1_000, userAgent: 'proba-ads-test', conversionPixelId: 't2_testpixel' },
    source,
    http
  );
}

const caller = () => ({
  issuer: 'proba-gateway',
  subject: 'gateway',
  jti: randomUUID(),
  keyId: 'k',
  expiresAt: new Date(Date.now() + 60_000),
});

function createReq(extra: Record<string, unknown> = {}) {
  return {
    traceId: FIXTURE_TRACE_ID,
    workspaceId: FIXTURE_WORKSPACE,
    userId: FIXTURE_USER_ID,
    goalId: FIXTURE_GOAL_ID,
    verb: 'ads.create_campaign' as const,
    args: fixtureCreateArgs({ name: 'broker-create' }),
    ...extra,
  };
}

describe('executeCampaignAction with broker tokens [fake broker + scripted Reddit]', () => {
  it('maps the connected account, uses the brokered token and attributes the action to the connection and approving user', async () => {
    const http = new FakeBrokerAndReddit([GRANT], REDDIT_CREATE);
    const store = new MemoryStore();
    await store.withTransaction((tx) =>
      tx.upsertAccount({ workspaceId: FIXTURE_WORKSPACE, platform: 'reddit', accountId: 'a2_previous', status: 'ready' })
    );

    const result = await executeCampaignAction(
      { config: testConfig(), store, provider: provider(http), clock: new SystemClock() },
      createReq(),
      caller(),
      randomUUID()
    );
    expect(result.ok).toBe(true);

    expect([...store.accounts.values()].map((a) => [a.accountId, a.status]).sort()).toEqual([
      ['a2_connected', 'ready'],
      ['a2_previous', 'unauthorized'],
    ]);
    // one broker call: the sync's token is cached and reused for the mutate
    expect(http.brokerCalls).toHaveLength(1);
    expect(http.reddit.calls.length).toBe(REDDIT_CREATE.length);
    for (const call of http.reddit.calls) expect(call.headers.authorization).toBe(`Bearer ${BROKER_TOKEN}`);

    const launched = store.outbox.find((e) => e.action === 'campaign.launched');
    expect(launched?.userId).toBe(FIXTURE_USER_ID);
    expect(launched?.details).toMatchObject({
      initiatedBy: 'user',
      connectionSource: 'broker',
      connectionId: CONNECTION_ID,
      connectedBy: CONNECTOR,
      providerAccountId: CONNECTED,
    });
    expect(JSON.stringify(store.outbox)).not.toContain(BROKER_TOKEN);
  });

  it('records policy as the initiator for delegated actions', async () => {
    const http = new FakeBrokerAndReddit([GRANT], REDDIT_CREATE);
    const store = new MemoryStore();
    const result = await executeCampaignAction(
      { config: testConfig(), store, provider: provider(http), clock: new SystemClock() },
      createReq({ initiatedBy: 'policy' }),
      caller(),
      randomUUID()
    );
    expect(result.ok).toBe(true);
    const done = store.outbox.find((e) => e.action === 'command.processed');
    expect(done?.details).toMatchObject({ initiatedBy: 'policy', connectionId: CONNECTION_ID });
    expect(JSON.parse(http.brokerCalls[0]!.body!).initiatedBy).toBe('system');
  });

  it('sends nothing to Reddit when the workspace is not connected [zero-mutation]', async () => {
    const http = new FakeBrokerAndReddit([{ status: 409, body: { error: 'not_connected', message: 'Connect Reddit' } }], []);
    const store = new MemoryStore();
    await store.withTransaction((tx) =>
      tx.upsertAccount({ workspaceId: FIXTURE_WORKSPACE, platform: 'reddit', accountId: 'a2_previous', status: 'ready' })
    );
    const outcome = await executeCampaignAction(
      { config: testConfig(), store, provider: provider(http), clock: new SystemClock() },
      createReq(),
      caller(),
      randomUUID()
    ).then(
      (r) => r,
      (e: Error) => ({ ok: false as const, code: e.name, message: e.message })
    );
    expect(outcome.ok).toBe(false);
    expect(http.reddit.calls).toHaveLength(0);
    expect([...store.accounts.values()][0]?.status).toBe('unauthorized');
  });

  it('leaves the mapping unchanged when the broker is unreachable', async () => {
    const http = new FakeBrokerAndReddit([{ status: 503, body: { error: 'provider_unavailable' } }, { status: 503, body: {} }], []);
    const store = new MemoryStore();
    await store.withTransaction((tx) =>
      tx.upsertAccount({ workspaceId: FIXTURE_WORKSPACE, platform: 'reddit', accountId: CONNECTED, status: 'ready' })
    );
    const result = await executeCampaignAction(
      { config: testConfig(), store, provider: provider(http), clock: new SystemClock() },
      createReq(),
      caller(),
      randomUUID()
    );
    expect(result.ok).toBe(false);
    // the billing gate asks the broker first and fails closed
    if (!result.ok) expect(result.code).toBe('billing_not_ready');
    expect(http.reddit.calls).toHaveLength(0);
    expect([...store.accounts.values()][0]?.status).toBe('ready');
  });
});
