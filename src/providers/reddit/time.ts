/** Reddit Get a Report starts_at/ends_at: YYYY-MM-DDTHH:00:00Z (hourly, no millis). */
export function toRedditHourUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid ISO timestamp: ${iso}`);
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:00:00Z`;
}

export function toUtcMillis(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid ISO timestamp: ${iso}`);
  }
  return date.toISOString();
}

export function addUtcHours(iso: string, hours: number): string {
  const date = new Date(iso);
  date.setUTCHours(date.getUTCHours() + hours);
  return date.toISOString();
}

export function addUtcDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

export function utcDayStart(dateYmd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
    throw new Error(`invalid DATE value: ${dateYmd}`);
  }
  return `${dateYmd}T00:00:00.000Z`;
}

/**
 * Follow Reddit pagination.next_url only when it stays on the configured Ads API origin.
 * Credentials in the URL are refused.
 */
export function redditSameOrigin(apiBaseUrl: string, candidate: string): boolean {
  try {
    const base = new URL(apiBaseUrl);
    const next = new URL(candidate);
    if (next.protocol !== base.protocol || next.host !== base.host) return false;
    if (next.username || next.password) return false;
    const basePath = base.pathname.replace(/\/$/, '') || '/';
    return next.pathname === basePath || next.pathname.startsWith(`${basePath}/`);
  } catch {
    return false;
  }
}
