import { z } from 'zod';
import { RequestValidationError } from '../errors.js';
import { researchAcceptanceBindingSchema, type ResearchAcceptanceBinding } from '../protocol.js';
import { AD_PLATFORMS, type AdsVerb } from '../types/http.js';
import { parseAdsCreative, REDDIT_POST_ID, REDDIT_PROFILE_ID, type AdsCreative } from './creative.js';
import { parseAdsSchedule, parseAdsTargeting, type AdsSchedule, type AdsTargeting } from './targeting.js';
import { assertLandingPageUrl } from './url.js';

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
    providerProfileId: z.string().regex(REDDIT_PROFILE_ID, 'providerProfileId must be a Reddit profile id').optional(),
    providerPostId: z.string().regex(REDDIT_POST_ID, 'providerPostId must be an existing Reddit post id (t3_…)').optional(),
    creative: z.unknown().optional(),
    targeting: z.unknown().optional(),
    schedule: z.unknown().optional(),
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
  providerProfileId?: string;
  providerPostId?: string;
  creative?: AdsCreative;
  targeting?: AdsTargeting;
  schedule?: AdsSchedule;
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
    const hasPost = Boolean(parsed.data.providerPostId);
    const hasCreative = parsed.data.creative !== undefined;
    if (hasPost && hasCreative) {
      throw new RequestValidationError(
        'pass either creative (Ads will create a structured post job) or providerPostId (existing t3_), not both'
      );
    }
    if (!hasPost && !hasCreative) {
      throw new RequestValidationError(
        'creative (approved copy/media) is required to create a Reddit structured post; providerPostId is only for an already-existing t3_. Neither was supplied.'
      );
    }
    if (parsed.data.platform !== 'reddit' && (hasCreative || parsed.data.targeting !== undefined || parsed.data.schedule !== undefined)) {
      throw new RequestValidationError('creative, targeting, and schedule are Reddit-only in this slice; other providers remain unconfigured');
    }
    return {
      verb: name,
      name: parsed.data.name,
      landingPageUrl: assertLandingPageUrl(parsed.data.landingPageUrl),
      dailyBudget: parsed.data.dailyBudget,
      currency: parsed.data.currency.toUpperCase(),
      platform: parsed.data.platform,
      expectedVersion: parsed.data.expectedVersion,
      providerAccountId: parsed.data.providerAccountId,
      providerProfileId: parsed.data.providerProfileId,
      providerPostId: parsed.data.providerPostId,
      creative: hasCreative ? parseAdsCreative(parsed.data.creative) : undefined,
      targeting: parseAdsTargeting(parsed.data.targeting),
      schedule: parseAdsSchedule(parsed.data.schedule),
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
