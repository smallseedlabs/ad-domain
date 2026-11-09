import type { ActionInitiator, ProviderAttribution } from './port.js';

/**
 * Audit details naming who acted and on which provider connection: the approving user
 * (or an owner-delegated policy) and the connection/account the provider call used.
 */
export function attributionDetails(
  initiatedBy: ActionInitiator | undefined,
  attribution: ProviderAttribution | undefined
): Record<string, unknown> {
  return {
    initiatedBy: initiatedBy ?? 'user',
    ...(attribution
      ? {
          connectionSource: attribution.source,
          providerAccountId: attribution.providerAccountId,
          ...(attribution.connectionId ? { connectionId: attribution.connectionId } : {}),
          ...(attribution.connectedBy ? { connectedBy: attribution.connectedBy } : {}),
        }
      : {}),
  };
}
