/** Reddit Ads goal_value / spend_cap / bid_value use microcurrency (1 unit = 1e-6 major). */
export const REDDIT_MICROS_PER_MAJOR = 1_000_000;

export function toMicros(major: number): number {
  return Math.round(major * REDDIT_MICROS_PER_MAJOR);
}
