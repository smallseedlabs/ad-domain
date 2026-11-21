import type { AdPlatform } from '../types/http.js';

export const MIN_TEST_BUDGET = 30;
export const MULTI_PLATFORM_MIN_BUDGET = 100;
export const PURCHASE_OPT_MIN_DAILY_BUDGET = 100;

export type PlannerObjective =
  | 'OUTCOME_TRAFFIC'
  | 'OUTCOME_AWARENESS'
  | 'OUTCOME_LEADS'
  | 'OUTCOME_SALES';

export type PlannerOptimizationGoal =
  | 'LINK_CLICKS'
  | 'LANDING_PAGE_VIEWS'
  | 'IMPRESSIONS'
  | 'OFFSITE_CONVERSIONS';

export interface PlannerClamp {
  field: string;
  requested: unknown;
  applied: unknown;
  reason: string;
}

export interface PlannerInput {
  totalBudget: number;
  currency: string;
  durationDays?: number;
  platforms: AdPlatform[];
  geolocations: string[];
  hasPixel: boolean;
  pixelVerified: boolean;
  goalIntent?: 'traffic' | 'awareness' | 'leads' | 'sales';
  creativeFormat?: 'IMAGE' | 'VIDEO' | 'TEXT';
  requestedCells?: number;
  requestedDailyBudget?: number;
  caps: {
    maxDailyBudget: number;
    maxLifetimeBudget: number;
  };
}

export interface PlannerPlan {
  totalBudget: number;
  dailyBudget: number;
  currency: string;
  durationDays: number;
  platforms: AdPlatform[];
  cells: number;
  objective: PlannerObjective;
  optimizationGoal: PlannerOptimizationGoal;
  creativeFormat: 'IMAGE' | 'VIDEO' | 'TEXT';
  countries: string[];
  clamps: PlannerClamp[];
}

export type PlannerResult =
  | { ok: true; plan: PlannerPlan }
  | { ok: false; code: 'missing_targeting' | 'budget_below_minimum' | 'missing_platform'; message: string };

function maxCellsForBudget(budget: number): number {
  if (budget >= 300) return 4;
  if (budget >= 100) return 2;
  return 1;
}

export function planCampaign(input: PlannerInput): PlannerResult {
  const countries = input.geolocations
    .map((g) => g.trim().toUpperCase())
    .filter((g) => /^[A-Z]{2}$/.test(g));

  if (countries.length === 0) {
    return {
      ok: false,
      code: 'missing_targeting',
      message: 'At least one ISO-2 country code in geolocations is required.',
    };
  }

  if (input.platforms.length === 0) {
    return {
      ok: false,
      code: 'missing_platform',
      message: 'At least one target platform is required.',
    };
  }

  if (!Number.isFinite(input.totalBudget) || input.totalBudget < MIN_TEST_BUDGET) {
    return {
      ok: false,
      code: 'budget_below_minimum',
      message: `Total budget ${input.totalBudget} is below minimum viable test budget (${MIN_TEST_BUDGET}).`,
    };
  }

  const clamps: PlannerClamp[] = [];

  let totalBudget = input.totalBudget;
  if (totalBudget > input.caps.maxLifetimeBudget) {
    clamps.push({
      field: 'totalBudget',
      requested: totalBudget,
      applied: input.caps.maxLifetimeBudget,
      reason: 'Clamped to workspace maxLifetimeBudget cap',
    });
    totalBudget = input.caps.maxLifetimeBudget;
  }

  const durationDays = Math.min(30, Math.max(3, Math.round(input.durationDays ?? 7)));

  let platforms = [...input.platforms];
  if (platforms.length > 1 && totalBudget < MULTI_PLATFORM_MIN_BUDGET) {
    const kept = [platforms[0]];
    clamps.push({
      field: 'platforms',
      requested: platforms,
      applied: kept,
      reason: `Multi-platform requires budget >= ${MULTI_PLATFORM_MIN_BUDGET}`,
    });
    platforms = kept;
  }

  const budgetCellCap = maxCellsForBudget(totalBudget);
  let cells = budgetCellCap;
  if (typeof input.requestedCells === 'number' && input.requestedCells >= 1) {
    const reqCells = Math.floor(input.requestedCells);
    if (reqCells <= budgetCellCap) {
      cells = reqCells;
    } else {
      cells = budgetCellCap;
      clamps.push({
        field: 'cells',
        requested: reqCells,
        applied: budgetCellCap,
        reason: `Budget ${totalBudget} supports at most ${budgetCellCap} test cell(s)`,
      });
    }
  }

  const defaultDaily = Number((totalBudget / durationDays).toFixed(2));
  let dailyBudget =
    typeof input.requestedDailyBudget === 'number' && input.requestedDailyBudget > 0
      ? input.requestedDailyBudget
      : defaultDaily;

  if (dailyBudget > input.caps.maxDailyBudget) {
    clamps.push({
      field: 'dailyBudget',
      requested: dailyBudget,
      applied: input.caps.maxDailyBudget,
      reason: 'Clamped to workspace maxDailyBudget cap',
    });
    dailyBudget = input.caps.maxDailyBudget;
  }

  const intent = input.goalIntent ?? 'traffic';
  const hasVerifiedPixel = input.hasPixel && input.pixelVerified;

  let objective: PlannerObjective = 'OUTCOME_TRAFFIC';
  let optimizationGoal: PlannerOptimizationGoal = 'LINK_CLICKS';

  if (intent === 'awareness') {
    objective = 'OUTCOME_AWARENESS';
    optimizationGoal = 'IMPRESSIONS';
  } else if ((intent === 'sales' || intent === 'leads') && hasVerifiedPixel) {
    if (intent === 'sales' && dailyBudget < PURCHASE_OPT_MIN_DAILY_BUDGET) {
      objective = 'OUTCOME_TRAFFIC';
      optimizationGoal = 'LANDING_PAGE_VIEWS';
      clamps.push({
        field: 'objective',
        requested: 'OUTCOME_SALES',
        applied: 'OUTCOME_TRAFFIC',
        reason: `Daily budget ${dailyBudget} < ${PURCHASE_OPT_MIN_DAILY_BUDGET} cannot sustain purchase conversion learning`,
      });
    } else {
      objective = intent === 'sales' ? 'OUTCOME_SALES' : 'OUTCOME_LEADS';
      optimizationGoal = 'OFFSITE_CONVERSIONS';
    }
  } else if ((intent === 'sales' || intent === 'leads') && !hasVerifiedPixel) {
    clamps.push({
      field: 'objective',
      requested: intent === 'sales' ? 'OUTCOME_SALES' : 'OUTCOME_LEADS',
      applied: 'OUTCOME_TRAFFIC',
      reason: 'Conversion pixel missing or unverified; falling back to traffic',
    });
  }

  return {
    ok: true,
    plan: {
      totalBudget,
      dailyBudget,
      currency: input.currency.toUpperCase(),
      durationDays,
      platforms,
      cells,
      objective,
      optimizationGoal,
      creativeFormat: input.creativeFormat ?? 'IMAGE',
      countries,
      clamps,
    },
  };
}
