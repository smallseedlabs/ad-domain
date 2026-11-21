import type { ParsedAdsArgs } from './verbs.js';

export type RedditObjective = 'CLICKS' | 'IMPRESSIONS' | 'CONVERSIONS';
export type MetaObjective =
  | 'OUTCOME_TRAFFIC'
  | 'OUTCOME_AWARENESS'
  | 'OUTCOME_ENGAGEMENT'
  | 'OUTCOME_LEADS'
  | 'OUTCOME_SALES';

export function resolveRedditObjective(input: {
  objective?: ParsedAdsArgs['objective'];
  conversionSignalVerified?: boolean;
}): RedditObjective {
  if (input.objective === 'OUTCOME_AWARENESS') {
    return 'IMPRESSIONS';
  }
  if (input.objective === 'OUTCOME_SALES' || input.objective === 'OUTCOME_LEADS') {
    return input.conversionSignalVerified === true ? 'CONVERSIONS' : 'CLICKS';
  }
  return 'CLICKS';
}

export function resolveMetaObjective(input: {
  objective?: ParsedAdsArgs['objective'];
  conversionSignalVerified?: boolean;
}): MetaObjective {
  if (input.objective === 'OUTCOME_AWARENESS') {
    return 'OUTCOME_AWARENESS';
  }
  if (input.objective === 'OUTCOME_ENGAGEMENT') {
    return 'OUTCOME_ENGAGEMENT';
  }
  if (input.objective === 'OUTCOME_SALES' || input.objective === 'OUTCOME_LEADS') {
    return input.conversionSignalVerified === true ? input.objective : 'OUTCOME_TRAFFIC';
  }
  return 'OUTCOME_TRAFFIC';
}
