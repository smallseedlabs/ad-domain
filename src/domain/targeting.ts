import { z } from 'zod';
import { RequestValidationError } from '../errors.js';

/** Official OpenAPI targeting.platforms; DESKTOP_LEGACY is documented as deprecated. */
export const REDDIT_PLATFORMS = ['ALL', 'DESKTOP', 'MOBILE_NATIVE', 'MOBILE_WEB', 'MOBILE_WEB_3X', 'SHREDTOP'] as const;
export const REDDIT_LOCATIONS = ['FEED', 'COMMENTS_PAGE'] as const;
export const REDDIT_GENDERS = ['FEMALE', 'MALE'] as const;
export const REDDIT_LANGUAGES = [
  'AR',
  'CS',
  'DA',
  'DE',
  'EL',
  'EN',
  'ES',
  'FI',
  'FR',
  'HU',
  'IT',
  'JA',
  'KO',
  'NL',
  'NO',
  'PL',
  'PT',
  'RO',
  'SV',
  'VI',
  'ZH',
] as const;

const communityName = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !/^t5_/i.test(value), {
    message: 'targeting.communities must be subreddit names (official Create Ad Group), not t5_ ids',
  });

const scheduleWindowSchema = z
  .object({
    startDay: z.number().int().min(0).max(6),
    endDay: z.number().int().min(0).max(6),
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(0).max(23),
  })
  .strict();

export const adsTargetingSchema = z
  .object({
    communities: z.array(communityName).max(400).optional(),
    excludedCommunities: z.array(communityName).max(400).optional(),
    geolocations: z.array(z.string().min(1).max(64)).max(20_000).optional(),
    excludedGeolocations: z.array(z.string().min(1).max(64)).max(20_000).optional(),
    interests: z.array(z.string().min(1).max(128)).max(200).optional(),
    keywords: z.array(z.string().min(1).max(128)).max(1000).optional(),
    excludedKeywords: z.array(z.string().min(1).max(128)).max(2000).optional(),
    platforms: z.array(z.enum(REDDIT_PLATFORMS)).max(7).optional(),
    locations: z.array(z.enum(REDDIT_LOCATIONS)).max(2).optional(),
    gender: z.enum(REDDIT_GENDERS).optional(),
    languages: z.array(z.enum(REDDIT_LANGUAGES)).max(21).optional(),
    expandTargeting: z.boolean().optional(),
    customAudienceIds: z.array(z.string().min(1).max(128)).max(100).optional(),
    excludedCustomAudienceIds: z.array(z.string().min(1).max(128)).max(100).optional(),
  })
  .strict();

export const adsScheduleSchema = z
  .object({
    startTime: z.iso.datetime().optional(),
    endTime: z.iso.datetime().optional(),
    windows: z.array(scheduleWindowSchema).max(14).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endTime && !value.startTime) {
      ctx.addIssue({
        code: 'custom',
        message: 'schedule.startTime is required when schedule.endTime is set (official Create Ad Group start_time rule)',
      });
    }
    if (value.startTime && value.endTime && value.endTime <= value.startTime) {
      ctx.addIssue({ code: 'custom', message: 'schedule.endTime must be after schedule.startTime' });
    }
  });

export type AdsTargeting = z.infer<typeof adsTargetingSchema>;
export type AdsSchedule = z.infer<typeof adsScheduleSchema>;

export function parseAdsTargeting(raw: unknown): AdsTargeting | undefined {
  if (raw === undefined) return undefined;
  if (raw && typeof raw === 'object' && 'platforms' in raw) {
    const platforms = (raw as { platforms?: unknown }).platforms;
    if (Array.isArray(platforms) && platforms.includes('DESKTOP_LEGACY')) {
      throw new RequestValidationError(
        'targeting.platforms DESKTOP_LEGACY is documented as deprecated and no longer supported. Fail closed.'
      );
    }
  }
  const parsed = adsTargetingSchema.safeParse(raw);
  if (!parsed.success) throw new RequestValidationError(parsed.error.issues[0]?.message ?? 'invalid targeting');
  return parsed.data;
}

export function parseAdsSchedule(raw: unknown): AdsSchedule | undefined {
  if (raw === undefined) return undefined;
  const parsed = adsScheduleSchema.safeParse(raw);
  if (!parsed.success) throw new RequestValidationError(parsed.error.issues[0]?.message ?? 'invalid schedule');
  return parsed.data;
}

/** Map Ads args onto official Create Ad Group targeting object. Omits empty keys. */
export function toRedditTargeting(targeting: AdsTargeting | undefined): Record<string, unknown> | undefined {
  if (!targeting) return undefined;
  const out: Record<string, unknown> = {};
  if (targeting.communities) out.communities = targeting.communities;
  if (targeting.excludedCommunities) out.excluded_communities = targeting.excludedCommunities;
  if (targeting.geolocations) out.geolocations = targeting.geolocations;
  if (targeting.excludedGeolocations) out.excluded_geolocations = targeting.excludedGeolocations;
  if (targeting.interests) out.interests = targeting.interests;
  if (targeting.keywords) out.keywords = targeting.keywords;
  if (targeting.excludedKeywords) out.excluded_keywords = targeting.excludedKeywords;
  if (targeting.platforms) out.platforms = targeting.platforms;
  if (targeting.locations) out.locations = targeting.locations;
  if (targeting.gender) out.gender = targeting.gender;
  if (targeting.languages) out.languages = targeting.languages;
  if (typeof targeting.expandTargeting === 'boolean') out.expand_targeting = targeting.expandTargeting;
  if (targeting.customAudienceIds) out.custom_audience_ids = targeting.customAudienceIds;
  if (targeting.excludedCustomAudienceIds) out.excluded_custom_audience_ids = targeting.excludedCustomAudienceIds;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function toRedditScheduleFields(schedule: AdsSchedule | undefined): {
  start_time?: string;
  end_time?: string;
  schedule?: Array<{ start_day: number; end_day: number; start_hour: number; end_hour: number }>;
} {
  if (!schedule) return {};
  const out: ReturnType<typeof toRedditScheduleFields> = {};
  if (schedule.startTime) out.start_time = schedule.startTime;
  if (schedule.endTime) out.end_time = schedule.endTime;
  if (schedule.windows && schedule.windows.length > 0) {
    out.schedule = schedule.windows.map((window) => ({
      start_day: window.startDay,
      end_day: window.endDay,
      start_hour: window.startHour,
      end_hour: window.endHour,
    }));
  }
  return out;
}
