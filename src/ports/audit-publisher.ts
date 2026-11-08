/**
 * Publish protocol AuditEvents. Domain writes go to the transactional outbox
 * first; the relay XADDs to `proba.audit.events`. Replay of that stream must
 * never execute Ads commands or call a provider.
 */
import type { AuditEvent, AuditEventInput } from '../protocol.js';

export type { AuditEvent, AuditEventInput };

export interface AuditPublisher {
  publish(event: AuditEventInput): Promise<void>;
  ping?(): Promise<void>;
  close?(): Promise<void>;
}
