export type ConversionSignalStatus = 'verified' | 'unverified';

export const SIGNAL_VERIFY_WINDOW_MS = 10 * 60 * 1000;

export interface ConversionSignalProbe {
  sendTestEvent(input: {
    accountId: string;
    pixelId: string;
    eventId: string;
    testEventCode?: string;
  }): Promise<{ ok: boolean; error?: string }>;
  checkEventReceived(input: {
    accountId: string;
    pixelId: string;
    eventId: string;
    sinceIso: string;
  }): Promise<{ received: boolean }>;
}

export async function verifyConversionSignal(
  probe: ConversionSignalProbe,
  input: {
    accountId: string;
    pixelId: string;
    eventId: string;
    now?: () => Date;
    elapsedMs?: number;
  }
): Promise<{ status: ConversionSignalStatus; reason: string }> {
  const now = (input.now ?? (() => new Date()))();
  const sent = await probe.sendTestEvent({
    accountId: input.accountId,
    pixelId: input.pixelId,
    eventId: input.eventId,
  });
  if (!sent.ok) {
    return {
      status: 'unverified',
      reason: sent.error ?? 'Failed to send test conversion event',
    };
  }

  const checked = await probe.checkEventReceived({
    accountId: input.accountId,
    pixelId: input.pixelId,
    eventId: input.eventId,
    sinceIso: now.toISOString(),
  });
  if (checked.received && (input.elapsedMs ?? 0) <= SIGNAL_VERIFY_WINDOW_MS) {
    return {
      status: 'verified',
      reason: 'Test conversion event observed by provider',
    };
  }

  return {
    status: 'unverified',
    reason: 'Test conversion event not observed within 10 minute verification window',
  };
}
