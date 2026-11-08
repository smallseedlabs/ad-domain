import type { Logger } from '../logger.js';
import type { AuditPublisher } from '../ports/audit-publisher.js';
import type { AdsStore } from '../store/port.js';

/**
 * Moves outbox rows to the audit bus. At-least-once: a crash between publish
 * and markPublished re-publishes; the consumer dedupes on eventId.
 * This relay never executes campaign commands.
 */
export class OutboxRelay {
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly options: {
      store: AdsStore;
      bus: AuditPublisher;
      logger: Logger;
      batchSize: number;
      pollIntervalMs: number;
      leaseMs: number;
    }
  ) {}

  async runOnce(): Promise<{ claimed: number; published: number; failed: number }> {
    const store = this.options.store;
    if (!store.claimOutbox || !store.markOutboxPublished || !store.markOutboxFailed) {
      return { claimed: 0, published: 0, failed: 0 };
    }
    const entries = await store.claimOutbox(this.options.batchSize, this.options.leaseMs);
    if (entries.length === 0) return { claimed: 0, published: 0, failed: 0 };
    const ids = entries.map((e) => e.id);
    try {
      for (const entry of entries) {
        await this.options.bus.publish(entry.event);
      }
      await store.markOutboxPublished(ids);
      return { claimed: entries.length, published: entries.length, failed: 0 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.options.logger.error({ err: err instanceof Error ? err.name : 'error' }, 'outbox relay failed to publish');
      await store.markOutboxFailed(ids, message);
      return { claimed: entries.length, published: 0, failed: entries.length };
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.runOnce();
        if (this.running && result.claimed < this.options.batchSize) {
          await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs));
        }
      } catch (err) {
        this.options.logger.error({ err: err instanceof Error ? err.name : 'error' }, 'outbox relay cycle failed');
        await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs));
      }
    }
  }
}
