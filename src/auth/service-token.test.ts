import { describe, expect, it } from 'vitest';
import { ServiceTokenAuth } from './service-token.js';
import { TokenVerificationError } from '../errors.js';
import { createTestSigner, mintGatewayToken } from '../testing/token-signer.js';

describe('gateway inbound service token [unit]', () => {
  it('accepts an EdDSA gateway token for audience proba-ads', async () => {
    const signer = await createTestSigner();
    const auth = new ServiceTokenAuth({
      keys: signer.keys,
      allowedIssuers: ['proba-gateway'],
      allowedSubjects: ['gateway'],
    });
    const token = await mintGatewayToken(signer);
    const caller = await auth.authenticate({ authorization: `Bearer ${token}` });
    expect(caller.issuer).toBe('proba-gateway');
    expect(caller.subject).toBe('gateway');
  });

  it('rejects missing bearer, wrong audience, and wrong subject', async () => {
    const signer = await createTestSigner();
    const auth = new ServiceTokenAuth({
      keys: signer.keys,
      allowedIssuers: ['proba-gateway'],
      allowedSubjects: ['gateway'],
    });
    await expect(auth.authenticate({})).rejects.toBeInstanceOf(TokenVerificationError);
    const wrongAud = await mintGatewayToken(signer, () => new Date(), { aud: 'proba-gateway' });
    await expect(auth.authenticate({ authorization: `Bearer ${wrongAud}` })).rejects.toBeInstanceOf(TokenVerificationError);
    const wrongSub = await mintGatewayToken(signer, () => new Date(), { sub: 'hub' });
    await expect(auth.authenticate({ authorization: `Bearer ${wrongSub}` })).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('captures optional workspaceId tenant scope', async () => {
    const signer = await createTestSigner();
    const auth = new ServiceTokenAuth({
      keys: signer.keys,
      allowedIssuers: ['proba-gateway'],
      allowedSubjects: ['gateway'],
    });
    const token = await mintGatewayToken(signer, () => new Date(), { workspaceId: 'ws-scoped' });
    const caller = await auth.authenticate({ authorization: `Bearer ${token}` });
    expect(caller.workspaceId).toBe('ws-scoped');
  });
});
