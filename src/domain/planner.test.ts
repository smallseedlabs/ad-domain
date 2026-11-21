import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { planCampaign, type PlannerInput } from './planner.js';

interface GoldenScenario {
  name: string;
  input: PlannerInput;
  expected: {
    ok: boolean;
    code?: string;
    cells?: number;
    objective?: string;
    optimizationGoal?: string;
    creativeFormat?: string;
    platformCount?: number;
    totalBudget?: number;
    dailyBudget?: number;
    minClamps?: number;
  };
}

const scenariosPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'planner.golden',
  'scenarios.json'
);
const scenarios = JSON.parse(readFileSync(scenariosPath, 'utf8')) as GoldenScenario[];

describe('H2-01 deterministic campaign planner (12 golden scenarios)', () => {
  it('contains all 12 golden scenarios', () => {
    expect(scenarios).toHaveLength(12);
  });

  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const result = planCampaign(scenario.input);
      expect(result.ok).toBe(scenario.expected.ok);
      if (!result.ok) {
        expect(result.code).toBe(scenario.expected.code);
        return;
      }
      const { plan } = result;
      if (scenario.expected.cells !== undefined) {
        expect(plan.cells).toBe(scenario.expected.cells);
      }
      if (scenario.expected.objective !== undefined) {
        expect(plan.objective).toBe(scenario.expected.objective);
      }
      if (scenario.expected.optimizationGoal !== undefined) {
        expect(plan.optimizationGoal).toBe(scenario.expected.optimizationGoal);
      }
      if (scenario.expected.creativeFormat !== undefined) {
        expect(plan.creativeFormat).toBe(scenario.expected.creativeFormat);
      }
      if (scenario.expected.platformCount !== undefined) {
        expect(plan.platforms).toHaveLength(scenario.expected.platformCount);
      }
      if (scenario.expected.totalBudget !== undefined) {
        expect(plan.totalBudget).toBe(scenario.expected.totalBudget);
      }
      if (scenario.expected.dailyBudget !== undefined) {
        expect(plan.dailyBudget).toBe(scenario.expected.dailyBudget);
      }
      if (scenario.expected.minClamps !== undefined) {
        expect(plan.clamps.length).toBeGreaterThanOrEqual(scenario.expected.minClamps);
      }
    });
  }
});
