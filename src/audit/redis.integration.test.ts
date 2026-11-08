import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { SystemClock } from '../ports/clock.js';
import { adsAuditEvent } from './emit.js';
import { RedisAuditPublisher } from './publisher.js';
import { realRedisUrl } from '../testing/real-env.js';

describe.skipIf(!realRedisUrl())('Redis audit publisher [real-redis]', () => {
  const url = realRedisUrl()!;
  const stream = `proba.audit.events.test.${randomUUID()}`;
  const publisher = new RedisAuditPublisher({ url, clock: new SystemClock(), stream });
  const reader = createClient({ url });

  afterAll(async () => {
    await publisher.close();
    if (reader.isOpen) {
      await reader.del(stream);
      await reader.quit();
    }
  });

  it('XADDs a protocol AuditEvent envelope and does not execute commands', async () => {
    await publisher.ping();
    await reader.connect();
    const event = adsAuditEvent({
      action: 'command.received',
      outcome: 'success',
      traceId: '33333333-3333-4333-8333-333333333333',
      workspaceId: 'workspace-test',
      clock: new SystemClock(),
      details: { verb: 'ads.pause_campaign' },
    });
    await publisher.publish(event);
    const entries = await reader.xRange(stream, '-', '+');
    expect(entries.length).toBe(1);
    const parsed = JSON.parse(entries[0]!.message.data) as { eventId: string; action: string; workspaceId: string };
    expect(parsed.eventId).toBe(event.eventId);
    expect(parsed.action).toBe('command.received');
    expect(parsed.workspaceId).toBe('workspace-test');
  });
});
