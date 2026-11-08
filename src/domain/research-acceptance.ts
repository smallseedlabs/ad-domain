import type { ResearchAcceptanceBinding } from '../protocol.js';
import type { AdsServiceConfig } from '../types/config.js';

export type ResearchAcceptanceMode = 'closed' | 'shape';

export type ResearchAcceptanceDecision =
  | { ok: true; mode: 'fixture' | 'shape' }
  | { ok: false; code: 'research_acceptance_unverified'; message: string };

export interface ResearchAcceptanceInput {
  binding: ResearchAcceptanceBinding;
  workspaceId: string;
  goalId?: string;
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
 * Test-only. Allows a syntactically valid binding when ADS_ALLOW_TEST_FAKES is on.
 * Not a Hub integration.
 */
export class FixtureResearchAcceptanceGate implements ResearchAcceptanceGate {
  verify(_input: ResearchAcceptanceInput): ResearchAcceptanceDecision {
    return { ok: true, mode: 'fixture' };
  }
}

export function researchAcceptanceGateFromConfig(config: AdsServiceConfig): ResearchAcceptanceGate {
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
