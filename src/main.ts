/**
 * Process entry. Internal HTTP only. Gateway is the only caller.
 * Provider adapters are unconfigured in this slice; mutations fail closed.
 */

import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';
import { buildApp } from './http/app.js';
import { ConfigError } from './errors.js';
import { adsAuditEvent } from './audit/emit.js';
import { MetricsSyncScheduler } from './domain/metrics-sync.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const runtime = await createRuntime(config);
  const app = await buildApp({
    config,
    auth: runtime.auth,
    audit: runtime.audit,
    clock: runtime.clock,
    logger: runtime.logger,
    store: runtime.store,
    provider: runtime.provider,
    ready: () => runtime.ready(),
  });

  await runtime.audit.publish(
    adsAuditEvent({
      action: 'system.started',
      outcome: 'success',
      traceId: '00000000-0000-4000-8000-000000000001',
      workspaceId: 'seedbed',
      clock: runtime.clock,
      details: { env: config.env, listen: `${config.listen.host}:${config.listen.port}`, provider: runtime.provider.name },
    })
  );

  await runtime.relayOnce();
  const relay = setInterval(() => {
    void runtime.relayOnce();
  }, config.audit.relayPollIntervalMs);
  relay.unref();

  await app.listen({ port: config.listen.port, host: config.listen.host });
  runtime.logger.info({ port: config.listen.port, host: config.listen.host }, 'ad-domain listening');

  // Read-only scheduled Reddit report sync; off unless ADS_METRICS_SYNC_ENABLED=true.
  const metricsSync = new MetricsSyncScheduler({
    config,
    store: runtime.store,
    provider: runtime.provider,
    clock: runtime.clock,
    logger: runtime.logger,
  });
  metricsSync.start();
  runtime.logger.info(
    metricsSync.enabled
      ? {
          metricsSync: 'enabled',
          intervalSeconds: config.metricsSync.intervalMs / 1000,
          firstRunInSeconds: config.metricsSync.initialDelayMs / 1000,
          lookbackDays: config.metricsSync.lookbackDays,
        }
      : { metricsSync: 'disabled' },
    'metrics sync scheduler'
  );

  const shutdown = async (signal: string) => {
    runtime.logger.info({ signal }, 'shutting down');
    try {
      await runtime.audit.publish(
        adsAuditEvent({
          action: 'system.stopped',
          outcome: 'success',
          traceId: '00000000-0000-4000-8000-000000000002',
          workspaceId: 'seedbed',
          clock: runtime.clock,
          details: { signal },
        })
      );
    } catch {
      // best-effort
    }
    await metricsSync.stop();
    clearInterval(relay);
    await app.close();
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  const message = err instanceof ConfigError ? err.message : err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
