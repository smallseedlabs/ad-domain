import { createClient, type RedisClientType } from 'redis';
import { AuditUnavailableError } from '../errors.js';
import type { AuditEventInput } from '../protocol.js';
import { validateAuditEvent } from '../protocol.js';
import type { AuditPublisher } from '../ports/audit-publisher.js';
import type { Clock } from '../ports/clock.js';
import { ADS_SERVICE_NAME } from '../types/config.js';

export const DEFAULT_AUDIT_STREAM = 'proba.audit.events';

export interface RedisAuditPublisherOptions {
  url: string;
  clock: Clock;
  stream?: string;
  maxStreamLength?: number;
  client?: RedisClientType;
}

export class RedisAuditPublisher implements AuditPublisher {
  private readonly stream: string;
  private readonly client: RedisClientType;
  private owned: boolean;
  private connecting?: Promise<void>;

  constructor(private readonly options: RedisAuditPublisherOptions) {
    this.stream = options.stream ?? DEFAULT_AUDIT_STREAM;
    this.owned = !options.client;
    this.client = options.client ?? createClient({ url: options.url });
  }

  private async connected(): Promise<RedisClientType> {
    if (this.client.isOpen) return this.client;
    this.connecting ??= this.client.connect().then(() => undefined);
    await this.connecting;
    return this.client;
  }

  async ping(): Promise<void> {
    const client = await this.connected();
    const pong = await client.ping();
    if (pong !== 'PONG') throw new AuditUnavailableError('audit redis ping failed');
  }

  async publish(event: AuditEventInput): Promise<void> {
    const parsed = validateAuditEvent(event);
    if (!parsed.success) {
      throw new Error(`audit event "${String(event.action)}" is not a valid AuditEvent: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    }
    const fields: Record<string, string> = {
      data: JSON.stringify(parsed.data),
      publishedAt: this.options.clock.isoNow(),
      key: parsed.data.workspaceId,
    };
    const client = await this.connected();
    const trim =
      this.options.maxStreamLength && this.options.maxStreamLength > 0
        ? { TRIM: { strategy: 'MAXLEN' as const, strategyModifier: '~' as const, threshold: this.options.maxStreamLength } }
        : undefined;
    await client.xAdd(this.stream, '*', fields, trim);
  }

  async close(): Promise<void> {
    if (this.owned && this.client.isOpen) await this.client.quit();
  }
}

export class LogAuditPublisher implements AuditPublisher {
  constructor(
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    nodeEnv: string = process.env.NODE_ENV ?? 'development'
  ) {
    if (nodeEnv === 'production') {
      throw new Error('The log audit publisher is not allowed when NODE_ENV=production');
    }
  }

  async publish(event: AuditEventInput): Promise<void> {
    const parsed = validateAuditEvent(event);
    if (!parsed.success) {
      throw new Error(`audit event "${String(event.action)}" is not a valid AuditEvent`);
    }
    this.write(
      JSON.stringify({
        audit: true,
        service: parsed.data.service ?? ADS_SERVICE_NAME,
        eventId: parsed.data.eventId,
        traceId: parsed.data.traceId,
        action: parsed.data.action,
        outcome: parsed.data.outcome,
        workspaceId: parsed.data.workspaceId,
      })
    );
  }
}

export class MemoryAuditPublisher implements AuditPublisher {
  readonly events: AuditEventInput[] = [];

  async publish(event: AuditEventInput): Promise<void> {
    const parsed = validateAuditEvent(event);
    if (!parsed.success) throw new Error('invalid AuditEvent');
    this.events.push(parsed.data);
  }
}
