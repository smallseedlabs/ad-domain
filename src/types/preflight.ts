import { z } from 'zod';

/** Matches gateway `src/types/preflight.ts` ads report contract. */
export const adsBillingClaimSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('verified'),
        mode: z.enum(['billing_eligibility', 'exact_balance']),
        eligible: z.boolean(),
        asOf: z.string().datetime(),
        source: z.literal('ads_domain'),
        currency: z.string().min(1).max(8).optional(),
        amount: z.number().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('unsupported'),
        lockedPolicy: z.literal('refuse_mutating'),
        reason: z.string().min(1),
      })
      .strict(),
    z.object({ kind: z.literal('unknown'), reason: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('unavailable'), reason: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('not_queried') }).strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.kind === 'verified' && value.mode !== 'exact_balance' && value.amount !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'amount is only valid with exact_balance' });
    }
  });
export type AdsBillingClaim = z.infer<typeof adsBillingClaimSchema>;

export const adsPreflightReportSchema = z
  .object({
    asOf: z.string().datetime(),
    freshUntil: z.string().datetime(),
    service: z
      .object({
        state: z.enum(['ready', 'missing', 'unavailable', 'unknown']),
        message: z.string().optional(),
      })
      .strict(),
    connection: z
      .object({
        state: z.enum(['ready', 'missing', 'unauthorized', 'unknown', 'unavailable']),
        platform: z.enum(['reddit', 'microsoft', 'google', 'meta']).optional(),
        message: z.string().optional(),
      })
      .strict(),
    permissions: z
      .object({
        state: z.enum(['ready', 'unauthorized', 'unknown', 'unavailable']),
        actions: z.array(z.string()).optional(),
        message: z.string().optional(),
      })
      .strict(),
    blueprint: z
      .object({
        state: z.enum(['ready', 'missing', 'unknown', 'not_required']),
        probaCampaignId: z.string().optional(),
        mapped: z.boolean().optional(),
        running: z.boolean().optional(),
        message: z.string().optional(),
      })
      .strict(),
    billing: adsBillingClaimSchema,
  })
  .strict();
export type AdsPreflightReport = z.infer<typeof adsPreflightReportSchema>;
