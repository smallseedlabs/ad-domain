import { z } from 'zod';
import { RequestValidationError } from '../errors.js';
import { assertLandingPageUrl } from './url.js';

export const REDDIT_POST_ID = /^t3_[A-Za-z0-9][A-Za-z0-9_]{1,127}$/;
export const REDDIT_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,127}$/;

/** Official OpenAPI components_enums_call_to_action (null omitted). */
export const REDDIT_CALL_TO_ACTION = [
  'Apply Now',
  'Contact Us',
  'Download',
  'Get a Quote',
  'Get Showtimes',
  'Install',
  'Learn More',
  'Order Now',
  'Play Now',
  'Pre-order Now',
  'See Menu',
  'Shop Now',
  'Sign Up',
  'View More',
  'Watch Now',
  'Book Now',
  'Buy Tickets',
  'Get Directions',
  'Listen Now',
  'Read More',
  'Subscribe',
  'Visit Store',
  'Donate Now',
  'Remind Me',
] as const;

const imageCreativeSchema = z
  .object({
    type: z.literal('IMAGE'),
    headline: z.string().min(1).max(300),
    body: z.string().min(1).max(40_000).optional(),
    mediaUrl: z.string().min(1).max(2048),
    callToAction: z.enum(REDDIT_CALL_TO_ACTION).optional(),
  })
  .strict();

const textCreativeSchema = z
  .object({
    type: z.literal('TEXT'),
    headline: z.string().min(1).max(300),
    body: z.string().min(1).max(40_000),
    textFormat: z.enum(['PLAIN_TEXT']).default('PLAIN_TEXT'),
  })
  .strict();

export const adsCreativeSchema = z.union([imageCreativeSchema, textCreativeSchema]);

export type AdsCreative = z.infer<typeof adsCreativeSchema>;

export function parseAdsCreative(raw: unknown): AdsCreative {
  if (raw && typeof raw === 'object' && 'type' in raw) {
    const type = (raw as { type?: unknown }).type;
    if (type === 'VIDEO' || type === 'CAROUSEL' || type === 'PROMOTED_POST') {
      throw new RequestValidationError(
        `creative.type ${String(type)} is documented by Reddit Ads API v3 but is not implemented in this slice (extra media/card fields). Fail closed; no post job was sent.`
      );
    }
  }
  const parsed = adsCreativeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RequestValidationError(parsed.error.issues[0]?.message ?? 'invalid creative');
  }
  if (parsed.data.type === 'IMAGE') {
    return { ...parsed.data, mediaUrl: assertLandingPageUrl(parsed.data.mediaUrl) };
  }
  return parsed.data;
}
