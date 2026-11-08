/**
 * Shared protocol types. Do not invent a parallel audit schema. This service
 * emits protocol AuditEvents onto the existing Redis stream; proba-audit
 * consumer writes ClickHouse. Replay of that stream must never execute Ads
 * commands.
 */
export type {
  AuditContent,
  AuditEvent,
  AuditEventInput,
} from '@smallseedlabs/proba-protocol';

export {
  AUDIT_ACTIONS,
  AUDIT_CONTENT_KINDS,
  AUDIT_CONTENT_MAX_CHARS,
  AUDIT_EVENT_VERSION,
  buildAuditContent,
  buildAuditEvent,
  generateSpanId,
  getAuditActionInfo,
  validateAuditEvent,
} from '@smallseedlabs/proba-protocol';
