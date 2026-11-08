/** Reddit Ads goal_value / spend_cap / bid_value / SPEND use microcurrency (1 unit = 1e-6 major). */
export const REDDIT_MICROS_PER_MAJOR = 1_000_000;

export function toMicros(major: number): number {
  return Math.round(major * REDDIT_MICROS_PER_MAJOR);
}

/** Official reports: divide SPEND (and CPC/ECPM) by 1e6 for major currency units. */
export function fromMicros(micros: number): number {
  return micros / REDDIT_MICROS_PER_MAJOR;
}
