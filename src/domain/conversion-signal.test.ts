import { describe, expect, it } from 'vitest';
import { SIGNAL_VERIFY_WINDOW_MS, verifyConversionSignal } from './conversion-signal.js';

describe('H2-06 conversion signal verification', () => {
  it('marks conversion_signal verified when test event is observed within 10 minutes', async () => {
    const res = await verifyConversionSignal(
      {
        sendTestEvent: async () => ({ ok: true }),
        checkEventReceived: async () => ({ received: true }),
      },
      { accountId: 'act_1', pixelId: 'px_1', eventId: 'evt_1', elapsedMs: 5_000 }
    );
    expect(res.status).toBe('verified');
  });

  it('marks conversion_signal unverified when not observed within 10 minutes or send fails', async () => {
    const notSeen = await verifyConversionSignal(
      {
        sendTestEvent: async () => ({ ok: true }),
        checkEventReceived: async () => ({ received: false }),
      },
      { accountId: 'act_1', pixelId: 'px_1', eventId: 'evt_2' }
    );
    expect(notSeen.status).toBe('unverified');

    const timedOut = await verifyConversionSignal(
      {
        sendTestEvent: async () => ({ ok: true }),
        checkEventReceived: async () => ({ received: true }),
      },
      {
        accountId: 'act_1',
        pixelId: 'px_1',
        eventId: 'evt_3',
        elapsedMs: SIGNAL_VERIFY_WINDOW_MS + 1000,
      }
    );
    expect(timedOut.status).toBe('unverified');
  });
});
