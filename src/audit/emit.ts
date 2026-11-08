import { ADS_SERVICE_NAME } from '../types/config.js';
import { buildAuditEvent, getAuditActionInfo, type AuditEvent, validateAuditEvent } from '../protocol.js';
import { redactDetails } from '../redact.js';
import type { Clock } from '../ports/clock.js';

export function adsAuditEvent(input: {
  action: string;
  outcome: 'success' | 'failure' | 'denied' | 'partial';
  traceId: string;
  workspaceId: string;
  userId?: string;
  goalId?: string;
  campaignId?: string;
  clock: Clock;
  errorCode?: string;
  details?: Record<string, unknown>;
}): AuditEvent {
  const info = getAuditActionInfo(input.action);
  const event = buildAuditEvent({
    traceId: input.traceId,
    workspaceId: input.workspaceId,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.goalId ? { goalId: input.goalId } : {}),
    ...(input.campaignId ? { campaignId: input.campaignId } : {}),
    actor: { type: 'service', id: ADS_SERVICE_NAME },
    service: ADS_SERVICE_NAME,
    action: input.action,
    category: info?.category ?? 'command',
    outcome: input.outcome,
    errorCode: input.errorCode,
    riskLevel: info?.riskLevel,
    occurredAt: input.clock.isoNow(),
    details: redactDetails({
      ...input.details,
    }),
  });
  const parsed = validateAuditEvent(event);
  if (!parsed.success) {
    throw new Error(`invalid AuditEvent ${input.action}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  return parsed.data;
}
