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

const REDDIT_INTEREST_IDS = new Set([
  'accessories_v3',
  'action_fps_games_v3',
  'action_v3',
  'adventure_games_v3',
  'africa_v3',
  'alcohol_v3',
  'amazed_v3',
  'animals_v3',
  'animation_v3',
  'anime_v3',
  'architecture_v3',
  'art_v3',
  'asia_v3',
  'auto_repair_v3',
  'auto_type_v3',
  'baking_v3',
  'baseball_v3',
  'basketball_v3',
  'bbq_grilling_v3',
  'beauty_v3',
  'beverages_v3',
  'boating_v3',
  'business_v3',
  'career_planning_v3',
  'cars_v3',
  'classical_v3',
  'college_education_v3',
  'college_sports_v3',
  'comedy_v3',
  'comics_v3',
  'consoles_gear_v3',
  'consumer_electronics_v3',
  'cooking_v3',
  'cordcutters_v3',
  'country_v3',
  'crime_v3',
  'cryptocurrency_v3',
  'cycling_v3',
  'dating_v3',
  'design_v3',
  'digital_art_v3',
  'diy_crafts_v3',
  'documentaries_v3',
  'drama_v3',
  'electronic_v3',
  'engineering_v3',
  'entertainment_v3',
  'entrepreneurship_v3',
  'esports_v3',
  'europe_v3',
  'extreme_sports_v3',
  'family_v3',
  'fantasy_v3',
  'fashion_trends_v3',
  'fast_food_v3',
  'filmmaking_v3',
  'fishing_v3',
  'fitness_v3',
  'flying_v3',
  'football_v3',
  'gaming_news_v3',
  'garden_farming_v3',
  'golf_v3',
  'hair_v3',
  'hardware_v3',
  'hiphop_v3',
  'hockey_v3',
  'home_decor_v3',
  'home_repair_v3',
  'horror_v3',
  'humor_v3',
  'hunting_v3',
  'indie_alt_v3',
  'intrigued_v3',
  'investing_v3',
  'jazz_v3',
  'kpop_v3',
  'languages_v3',
  'law_v3',
  'life_advice_v3',
  'literature_v3',
  'makeup_v3',
  'marketing_v3',
  'marketplace_v3',
  'marriage_v3',
  'memes_v3',
  'mens_fashion_v3',
  'metal_v3',
  'middle_east_v3',
  'mobile_gadgets_v3',
  'mobile_gaming_v3',
  'motor_sports_v3',
  'motorbikes_v3',
  'music_v3',
  'musicians_v3',
  'nails_v3',
  'nature_v3',
  'north_america_v3',
  'nutrition_v3',
  'oceania_v3',
  'other_sports_v3',
  'outdoors_v3',
  'parenthood_v3',
  'pc_games_v3',
  'performing_arts_v3',
  'personal_finance_v3',
  'pets_v3',
  'photography_v3',
  'podcasts_v3',
  'pop_v3',
  'programming_v3',
  'r&b_v3',
  'real_estate_v3',
  'reality_v3',
  'reddit_meta_v3',
  'rock_v3',
  'rpg_games_v3',
  'rugby_v3',
  'satisfied_v3',
  'science_fiction_v3',
  'science_v3',
  'simulation_games_v3',
  'skincare_v3',
  'soccer_v3',
  'software_v3',
  'south_america_v3',
  'spooked_v3',
  'sports_games_v3',
  'strategy_games_v3',
  'streamers_v3',
  'streetwear_v3',
  'superhero_v3',
  'swimming_v3',
  'tabletop_games_v3',
  'tattoos_piercings_v3',
  'tennis_v3',
  'toys_v3',
  'track_and_field_v3',
  'trains_v3',
  'travel_lifestyle_v3',
  'tv_movies_v3',
  'us_news_v3',
  'vegetarian_vegan_v3',
  'video_gaming_v3',
  'virtual_reality_v3',
  'watches_v3',
  'weddings_v3',
  'wellness_v3',
  'wholesome_v3',
  'wintersports_v3',
  'womens_fashion_v3',
  'world_news_v3',
  'wrestling_v3',
]);

const REDDIT_INTEREST_ALIASES: Record<string, string> = {
  business: 'business_v3',
  'business & finance': 'business_v3',
  'business software': 'software_v3',
  software: 'software_v3',
  'software & apps': 'software_v3',
  technology: 'software_v3',
  'technology & computing': 'software_v3',
  'enterprise technology': 'software_v3',
  'artificial intelligence': 'software_v3',
  ai: 'software_v3',
  programming: 'programming_v3',
  hardware: 'hardware_v3',
  'computers & hardware': 'hardware_v3',
  'consumer electronics': 'consumer_electronics_v3',
  engineering: 'engineering_v3',
  marketing: 'marketing_v3',
  'marketing & social media': 'marketing_v3',
  startups: 'entrepreneurship_v3',
  'startups & small business': 'entrepreneurship_v3',
  'small business': 'entrepreneurship_v3',
  entrepreneurship: 'entrepreneurship_v3',
  finance: 'personal_finance_v3',
  'personal finance': 'personal_finance_v3',
  investing: 'investing_v3',
  'stocks & investing': 'investing_v3',
  cryptocurrency: 'cryptocurrency_v3',
  crypto: 'cryptocurrency_v3',
  design: 'design_v3',
  art: 'art_v3',
  science: 'science_v3',
  education: 'college_education_v3',
  gaming: 'video_gaming_v3',
  fitness: 'fitness_v3',
  wellness: 'wellness_v3',
  law: 'law_v3',
  'real estate': 'real_estate_v3',
  'career planning': 'career_planning_v3',
};

export function normalizeRedditInterests(interests: readonly string[] | undefined): string[] | undefined {
  if (!interests || interests.length === 0) return undefined;
  const out: string[] = [];
  for (const raw of interests) {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) continue;
    const mapped = REDDIT_INTEREST_IDS.has(trimmed)
      ? trimmed
      : REDDIT_INTEREST_IDS.has(`${trimmed}_v3`)
        ? `${trimmed}_v3`
        : REDDIT_INTEREST_ALIASES[trimmed];
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out.length > 0 ? out : undefined;
}

/** Map Ads args onto official Create Ad Group targeting object. Omits empty keys and admin-only fields. */
export function toRedditTargeting(targeting: AdsTargeting | undefined): Record<string, unknown> | undefined {
  if (!targeting) return undefined;
  const out: Record<string, unknown> = {};
  if (targeting.communities && targeting.communities.length > 0) out.communities = targeting.communities;
  if (targeting.excludedCommunities && targeting.excludedCommunities.length > 0) out.excluded_communities = targeting.excludedCommunities;
  if (targeting.geolocations && targeting.geolocations.length > 0) out.geolocations = targeting.geolocations;
  if (targeting.excludedGeolocations && targeting.excludedGeolocations.length > 0) {
    out.excluded_geolocations = targeting.excludedGeolocations;
  }
  const interests = normalizeRedditInterests(targeting.interests);
  if (interests) out.interests = interests;
  if (targeting.keywords && targeting.keywords.length > 0) out.keywords = targeting.keywords;
  if (targeting.excludedKeywords && targeting.excludedKeywords.length > 0) out.excluded_keywords = targeting.excludedKeywords;
  // Note: Reddit Ads API v3 rejects `targeting.platforms` for non-admin accounts ("platforms is an admin only field.").
  if (targeting.locations && targeting.locations.length > 0) out.locations = targeting.locations;
  if (targeting.gender) out.gender = targeting.gender;
  if (targeting.languages && targeting.languages.length > 0) out.languages = targeting.languages;
  if (typeof targeting.expandTargeting === 'boolean') out.expand_targeting = targeting.expandTargeting;
  if (targeting.customAudienceIds && targeting.customAudienceIds.length > 0) out.custom_audience_ids = targeting.customAudienceIds;
  if (targeting.excludedCustomAudienceIds && targeting.excludedCustomAudienceIds.length > 0) {
    out.excluded_custom_audience_ids = targeting.excludedCustomAudienceIds;
  }
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
