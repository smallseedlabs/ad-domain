import type { ResearchAcceptanceBinding } from '../protocol.js';
import type { ResearchAttestation } from './verbs.js';
import type { AdsServiceConfig } from '../types/config.js';

export type ResearchAcceptanceMode = 'closed' | 'shape' | 'gateway_attested';

export type ResearchAcceptanceDecision =
  | { ok: true; mode: 'fixture' | 'shape' | 'gateway_attested' }
  | { ok: false; code: 'research_acceptance_unverified'; message: string };

export interface ResearchAcceptanceInput {
  binding: ResearchAcceptanceBinding;
  workspaceId: string;
  goalId?: string;
  /** Gateway attestation forwarded with create (gateway holds the accepted artifact). */
  attestation?: ResearchAttestation;
  /** Normalized create landingPageUrl; the attestation must name the same URL. */
  landingPageUrl?: string;
}

/**
 * Verification seam for Hub-accepted research. Ads does not call Hub.
 * Default is fail-closed: a well-formed binding is not treated as accepted.
 */
export interface ResearchAcceptanceGate {
  verify(input: ResearchAcceptanceInput): ResearchAcceptanceDecision;
}

const CLOSED_MESSAGE =
  'researchAcceptance is well-formed but not verified. Ads does not call Hub and will not treat a binding as accepted until a Hub verification contract exists. No provider mutation was sent.';

export class ClosedResearchAcceptanceGate implements ResearchAcceptanceGate {
  verify(_input: ResearchAcceptanceInput): ResearchAcceptanceDecision {
    return { ok: false, code: 'research_acceptance_unverified', message: CLOSED_MESSAGE };
  }
}

/** Schema already applied by parseVerbArgs. Does not prove Hub stored the acceptance. */
export class ShapeOnlyResearchAcceptanceGate implements ResearchAcceptanceGate {
  verify(_input: ResearchAcceptanceInput): ResearchAcceptanceDecision {
    return { ok: true, mode: 'shape' };
  }
}

/**
 * Opt-in (`ADS_RESEARCH_ACCEPTANCE_MODE=gateway_attested`). Accepts a binding
 * only when the authenticated gateway caller (EdDSA service token, issuer and
 * subject allowlisted) also attests that the artifact is `accepted` for the
 * exact landing URL with at least one source and finding. This is trust in the
 * signed gateway, which owns the accepted research store; it is not an
 * independent Hub lookup. Default remains `closed`.
 */
export class GatewayAttestedResearchAcceptanceGate implements ResearchAcceptanceGate {
  verify(input: ResearchAcceptanceInput): ResearchAcceptanceDecision {
    const a = input.attestation;
    const refuse = (why: string): ResearchAcceptanceDecision => ({
      ok: false,
      code: 'research_acceptance_unverified',
      message: `gateway research attestation refused: ${why}. No provider mutation was sent.`,
    });
    if (!a) return refuse('researchAttestation is missing');
    if (a.status !== 'accepted') return refuse('artifact is not accepted');
    if (!input.landingPageUrl || a.landingPageUrl !== input.landingPageUrl) {
      return refuse('attested landing URL does not match the create landingPageUrl');
    }
    if (a.sourceCount < 1 || a.findingCount < 1) return refuse('attested artifact has no sources or findings');
    return { ok: true, mode: 'gateway_attested' };
  }
}

/**
 * Test-only. Allows a syntactically valid binding when ADS_ALLOW_TEST_FAKES is on.
 * Not a Hub integration.
 */
export class FixtureResearchAcceptanceGate implements ResearchAcceptanceGate {
  verify(_input: ResearchAcceptanceInput): ResearchAcceptanceDecision {
    return { ok: true, mode: 'fixture' };
  }
}

export function researchAcceptanceGateFromConfig(config: AdsServiceConfig): ResearchAcceptanceGate {
  if (config.ads.researchAcceptanceMode === 'gateway_attested') {
    return new GatewayAttestedResearchAcceptanceGate();
  }
  if (config.env === 'production') {
    return new ClosedResearchAcceptanceGate();
  }
  if (config.ads.allowTestFakes) {
    return new FixtureResearchAcceptanceGate();
  }
  if (config.ads.researchAcceptanceMode === 'shape') {
    return new ShapeOnlyResearchAcceptanceGate();
  }
  return new ClosedResearchAcceptanceGate();
}
