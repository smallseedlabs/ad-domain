import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { FIXTURE_RESEARCH_ACCEPTANCE } from '../testing/config.js';
import {
  ClosedResearchAcceptanceGate,
  FixtureResearchAcceptanceGate,
  ShapeOnlyResearchAcceptanceGate,
  researchAcceptanceGateFromConfig,
} from './research-acceptance.js';

const input = {
  binding: { ...FIXTURE_RESEARCH_ACCEPTANCE },
  workspaceId: 'workspace-test',
  goalId: '44444444-4444-4444-8444-444444444444',
};

describe('research acceptance gate [unit]', () => {
  it('fails closed by default and does not claim Hub verification', () => {
    const closed = new ClosedResearchAcceptanceGate().verify(input);
    expect(closed.ok).toBe(false);
    if (!closed.ok) {
      expect(closed.code).toBe('research_acceptance_unverified');
      expect(closed.message.toLowerCase()).toContain('does not call hub');
    }
  });

  it('uses the fixture gate only when test fakes are allowed', () => {
    const fakes = researchAcceptanceGateFromConfig(
      loadConfig({ NODE_ENV: 'test', AUDIT_PUBLISHER: 'log', ADS_ALLOW_TEST_FAKES: 'true' })
    );
    expect(fakes).toBeInstanceOf(FixtureResearchAcceptanceGate);
    expect(fakes.verify(input).ok).toBe(true);

    const closed = researchAcceptanceGateFromConfig(loadConfig({ NODE_ENV: 'test', AUDIT_PUBLISHER: 'log' }));
    expect(closed).toBeInstanceOf(ClosedResearchAcceptanceGate);
    expect(closed.verify(input).ok).toBe(false);
  });

  it('uses shape-only only when explicitly set outside production (still not Hub)', () => {
    const shape = researchAcceptanceGateFromConfig(
      loadConfig({ NODE_ENV: 'test', AUDIT_PUBLISHER: 'log', ADS_RESEARCH_ACCEPTANCE_MODE: 'shape' })
    );
    expect(shape).toBeInstanceOf(ShapeOnlyResearchAcceptanceGate);
    expect(shape.verify(input).ok).toBe(true);
  });
});
