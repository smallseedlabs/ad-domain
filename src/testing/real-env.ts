/** Real Postgres/Redis integration. Skipped when URLs are unset. */

export function realPostgresUrl(): string | undefined {
  const url = (process.env.ADS_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '').trim();
  return url || undefined;
}

export function realRedisUrl(): string | undefined {
  const url = (process.env.ADS_TEST_REDIS_URL ?? process.env.REDIS_URL ?? '').trim();
  return url || undefined;
}
