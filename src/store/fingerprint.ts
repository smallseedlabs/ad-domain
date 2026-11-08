import { createHash } from 'node:crypto';

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function requestFingerprint(verb: string, args: Record<string, unknown>): string {
  const canonical = JSON.stringify(sortValue({ verb, args }));
  return createHash('sha256').update(canonical).digest('hex');
}
