import { z } from 'zod';

export const AD_PLATFORMS = ['reddit', 'microsoft', 'google', 'meta'] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

export const adsVerbSchema = z.enum([
  'ads.create_campaign',
  'ads.update_campaign',
  'ads.pause_campaign',
  'ads.resume_campaign',
  'create_campaign',
  'update_campaign',
  'pause_campaign',
  'resume_campaign',
]);
export type AdsVerb = z.infer<typeof adsVerbSchema>;

export const campaignActionRequestSchema = z
  .object({
    traceId: z.string().uuid(),
    workspaceId: z.string().min(1).max(256),
    userId: z.string().uuid(),
    goalId: z.string().uuid().optional(),
    verb: adsVerbSchema,
    args: z.record(z.unknown()),
    idempotencyKey: z.string().min(1).max(128).optional(),
    decisionId: z.string().min(1).max(128).optional(),
    commandId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type CampaignActionRequest = z.infer<typeof campaignActionRequestSchema>;

export const preflightRequestSchema = z
  .object({
    workspaceId: z.string().min(1).max(256),
    userId: z.string().uuid(),
    goalId: z.string().uuid().optional(),
    verb: z.string().min(1).max(128).optional(),
    platform: z.enum(AD_PLATFORMS).optional(),
    probaCampaignId: z.string().min(1).max(128).optional(),
    mappingRequired: z.boolean(),
  })
  .strict();
export type PreflightRequest = z.infer<typeof preflightRequestSchema>;

export type AdsDomainResult =
  | {
      ok: true;
      data: {
        probaCampaignId: string;
        version?: number;
        landingPageUrl?: string;
        mappings?: Array<{
          probaCampaignId: string;
          provider: AdPlatform;
          providerCampaignId: string;
          providerAdGroupId?: string;
          providerAdId?: string;
        }>;
        [key: string]: unknown;
      };
    }
  | { ok: false; code: string; message: string };
