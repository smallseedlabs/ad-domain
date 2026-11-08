import { describe, expect, it } from 'vitest';
import { adsAuditEvent } from './emit.js';
import { MemoryAuditPublisher } from './publisher.js';
import { OutboxRelay } from './relay.js';
import { createLogger } from '../logger.js';
import { SystemClock } from '../ports/clock.js';
import { MemoryStore } from '../store/memory.js';
import { FIXTURE_TRACE_ID, FIXTURE_WORKSPACE } from '../testing/config.js';

describe('OutboxRelay [fake-store]', () => {
  it('invokes class-bound store methods (does not detach this)', async () => {
    const store = new MemoryStore();
    const event = adsAuditEvent({
      action: 'command.received',
      outcome: 'success',
      traceId: FIXTURE_TRACE_ID,
      workspaceId: FIXTURE_WORKSPACE,
      clock: new SystemClock(),
      details: { verb: 'ads.pause_campaign' },
    });
    await store.withTransaction((tx) => tx.enqueueAudit(event));
    const bus = new MemoryAuditPublisher();
    const relay = new OutboxRelay({
      store,
      bus,
      logger: createLogger('silent'),
      batchSize: 10,
      pollIntervalMs: 50,
      leaseMs: 1_000,
    });
    const cycle = await relay.runOnce();
    expect(cycle.published).toBe(1);
    expect(bus.events).toHaveLength(1);
    expect(bus.events[0]?.eventId).toBe(event.eventId);
    expect(store.publishedOutboxIds).toEqual(['1']);
  });
});
