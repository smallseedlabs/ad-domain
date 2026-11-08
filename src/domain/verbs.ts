import { z } from 'zod';
import { RequestValidationError } from '../errors.js';
import { researchAcceptanceBindingSchema, type ResearchAcceptanceBinding } from '../protocol.js';
import { AD_PLATFORMS, type AdsVerb } from '../types/http.js';
import { assertLandingPageUrl } from './url.js';

const REDDIT_POST_ID = /^t3_[A-Za-z0-9][A-Za-z0-9_]{1,127}$/;

export type SpendClass = 'none' | 'safety_decrease' | 'spend_increase';

export function canonicalVerb(verb: string): AdsVerb {
  if (verb.startsWith('ads.')) return verb as AdsVerb;
  return `ads.${verb}` as AdsVerb;
}

export function spendClassFor(verb: string, args: Record<string, unknown>): SpendClass {
  const name = canonicalVerb(verb);
  if (name === 'ads.pause_campaign') return 'safety_decrease';
  if (name === 'ads.create_campaign' || name === 'ads.resume_campaign') return 'spend_increase';
  if (name === 'ads.update_campaign') {
    return typeof args.dailyBudget === 'number' ? 'spend_increase' : 'none';
  }
  return 'spend_increase';
}

const createArgsSchema = z
  .object({
    name: z.string().min(1).max(200),
    landingPageUrl: z.string().min(1).max(2048),
    dailyBudget: z.number().finite().positive(),
    currency: z.string().length(3),
    platform: z.enum(AD_PLATFORMS),
    expectedVersion: z.number().int().positive().optional(),
    providerAccountId: z.string().min(1).max(128).optional(),
    providerPostId: z.string().regex(REDDIT_POST_ID, 'providerPostId must be an existing Reddit post id (t3_…)'),
    researchAcceptance: researchAcceptanceBindingSchema,
  })
  .strict();

const updateArgsSchema = z
  .object({
    probaCampaignId: z.string().min(1).max(128),
    name: z.string().min(1).max(200).optional(),
    dailyBudget: z.number().finite().positive().optional(),
    landingPageUrl: z.string().min(1).max(2048).optional(),
    expectedVersion: z.number().int().positive().optional(),
    providerAccountId: z.string().min(1).max(128).optional(),
  })
  .strict();

const idArgsSchema = z
  .object({
    probaCampaignId: z.string().min(1).max(128),
    expectedVersion: z.number().int().positive().optional(),
    providerAccountId: z.string().min(1).max(128).optional(),
  })
  .strict();

export interface ParsedAdsArgs {
  verb: 'ads.create_campaign' | 'ads.update_campaign' | 'ads.pause_campaign' | 'ads.resume_campaign';
  name?: string;
  landingPageUrl?: string;
  dailyBudget?: number;
  currency?: string;
  platform?: (typeof AD_PLATFORMS)[number];
  probaCampaignId?: string;
  expectedVersion?: number;
  providerAccountId?: string;
  providerPostId?: string;
  researchAcceptance?: ResearchAcceptanceBinding;
}

export function parseVerbArgs(verb: string, raw: Record<string, unknown>): ParsedAdsArgs {
  if (typeof raw.providerCampaignId === 'string' || typeof raw.providerAdId === 'string') {
    throw new RequestValidationError('pass probaCampaignId only; provider resource ids are mapped by this domain');
  }
  const name = canonicalVerb(verb);
  if (name === 'ads.create_campaign') {
    const parsed = createArgsSchema.safeParse(raw);
    if (!parsed.success) throw new RequestValidationError(parsed.error.issues[0]?.message ?? 'invalid create args');
    return {
      verb: name,
      name: parsed.data.name,
      landingPageUrl: assertLandingPageUrl(parsed.data.landingPageUrl),
      dailyBudget: parsed.data.dailyBudget,
      currency: parsed.data.currency.toUpperCase(),
      platform: parsed.data.platform,
      expectedVersion: parsed.data.expectedVersion,
      providerAccountId: parsed.data.providerAccountId,
      providerPostId: parsed.data.providerPostId,
      researchAcceptance: parsed.data.researchAcceptance,
    };
  }
  if (name === 'ads.update_campaign') {
    const parsed = updateArgsSchema.safeParse(raw);
    if (!parsed.success) throw new RequestValidationError(parsed.error.issues[0]?.message ?? 'invalid update args');
    return {
      verb: name,
      probaCampaignId: parsed.data.probaCampaignId,
      name: parsed.data.name,
      dailyBudget: parsed.data.dailyBudget,
      landingPageUrl: parsed.data.landingPageUrl === undefined ? undefined : assertLandingPageUrl(parsed.data.landingPageUrl),
      expectedVersion: parsed.data.expectedVersion,
      providerAccountId: parsed.data.providerAccountId,
    };
  }
  if (name === 'ads.pause_campaign' || name === 'ads.resume_campaign') {
    const parsed = idArgsSchema.safeParse(raw);
    if (!parsed.success) throw new RequestValidationError(parsed.error.issues[0]?.message ?? 'invalid campaign args');
    return {
      verb: name,
      probaCampaignId: parsed.data.probaCampaignId,
      expectedVersion: parsed.data.expectedVersion,
      providerAccountId: parsed.data.providerAccountId,
    };
  }
  throw new RequestValidationError(`verb ${verb} is not supported`);
}
