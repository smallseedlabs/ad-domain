import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SystemClock } from './ports/clock.js';
import { adsAuditEvent } from './audit/emit.js';
import { validateMetricObservation } from './protocol.js';
import { FIXTURE_TRACE_ID, FIXTURE_WORKSPACE } from './testing/config.js';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

interface JsonSchemaNode {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  definitions?: Record<string, JsonSchemaNode>;
}

interface Bundle {
  version: string;
  $schema: string;
  definitions: Record<string, JsonSchemaNode>;
}

interface Contract {
  pin: string;
  bundleVersion: string;
  definitions: Record<string, { required: string[] }>;
}

function unwrap(def: JsonSchemaNode, name: string): JsonSchemaNode {
  if (def.properties) return def;
  const named = def.definitions?.[name];
  if (named?.properties) return named;
  return def;
}

const bundle = require('@smallseedlabs/proba-protocol/schemas') as Bundle;
const contract = JSON.parse(
  readFileSync(join(root, 'tests/fixtures/ads-consumer-schema-contract.json'), 'utf8')
) as Contract;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};

describe('protocol JSON Schema consumer fixture [unit]', () => {
  it('pins verified protocol PR23 SHA 298eeb4, not e310475 or a v0.6.0 tag', () => {
    const spec = pkg.dependencies['@smallseedlabs/proba-protocol'];
    expect(spec).toBe(`github:smallseedlabs/proba-protocol#${contract.pin}`);
    expect(spec).not.toMatch(/e310475/);
    expect(spec).not.toMatch(/#v0\.6\.0$/);
  });

  it('loads the protocol 0.6.0 draft-07 bundle with contracted definitions', () => {
    expect(bundle.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(bundle.version).toBe(contract.bundleVersion);
    for (const name of Object.keys(contract.definitions)) {
      expect(bundle.definitions[name]).toBeDefined();
    }
  });

  it('preserves required wire fields for AuditEvent and MetricObservation', () => {
    for (const [name, spec] of Object.entries(contract.definitions)) {
      const node = unwrap(bundle.definitions[name]!, name);
      expect(node.required).toEqual(expect.arrayContaining(spec.required));
      for (const field of spec.required) {
        expect(node.properties).toHaveProperty(field);
      }
    }
  });

  it('runtime validators accept an Ads AuditEvent and a MetricObservation', () => {
    const event = adsAuditEvent({
      action: 'command.received',
      outcome: 'success',
      traceId: FIXTURE_TRACE_ID,
      workspaceId: FIXTURE_WORKSPACE,
      clock: new SystemClock(),
      details: { verb: 'ads.pause_campaign' },
    });
    expect(event.action).toBe('command.received');

    const observation = validateMetricObservation({
      version: 1,
      platform: 'reddit',
      accountId: 'a2_test',
      campaignId: 'cmp_1',
      granularity: 'day',
      periodStart: '2026-11-01T00:00:00.000Z',
      periodEnd: '2026-11-02T00:00:00.000Z',
      metrics: { impressions: 1, clicks: 0, spend: 0, conversions: 0 },
      currency: 'USD',
      fetchedAt: '2026-11-08T12:00:00.000Z',
      revision: 0,
    });
    expect(observation.success).toBe(true);
  });
});
