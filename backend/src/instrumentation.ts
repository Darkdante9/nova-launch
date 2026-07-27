/**
 * OpenTelemetry bootstrap (#1333)
 *
 * This module MUST be loaded before any other application module so that
 * the Node.js auto-instrumentations (http, express, pg, etc.) can patch
 * their target modules before they are `require`d elsewhere.
 *
 * Wiring:
 *   - `npm run dev`   -> `tsx watch -r ./src/instrumentation.ts src/index.ts`
 *   - `npm run start` -> `node -r ./dist/instrumentation.js dist/index.js`
 *
 * Both forms `require` this file first, which is the officially supported
 * way to initialize @opentelemetry/sdk-node for CommonJS projects.
 *
 * Spans are exported via OTLP/HTTP to the local Jaeger all-in-one instance
 * defined in the root `docker-compose.yml` (the `jaeger` service exposes its
 * OTLP HTTP receiver on port 4318).
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'nova-launch-backend';

const OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
  'http://localhost:4318/v1/traces';

if (process.env.OTEL_DEBUG === 'true') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

const traceExporter = new OTLPTraceExporter({
  url: OTLP_ENDPOINT,
});

const sdk = new NodeSDK({
  serviceName: SERVICE_NAME,
  traceExporter,
  instrumentations: [
    getNodeAutoInstrumentations({
      // Filesystem instrumentation is extremely noisy and rarely useful;
      // everything else (http, express, pg, ioredis, dns, ...) stays enabled.
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

// Only enable tracing when explicitly requested, or by default outside of
// test runs — keeps `vitest` runs (and CI) free of exporter network calls
// and dangling timers unless a developer opts in.
const otelDisabled =
  process.env.OTEL_SDK_DISABLED === 'true' || process.env.NODE_ENV === 'test';

if (!otelDisabled) {
  try {
    sdk.start();
    // eslint-disable-next-line no-console
    console.log(
      `[otel] tracing initialized — service=${SERVICE_NAME} exporter=${OTLP_ENDPOINT}`
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[otel] failed to initialize tracing', err);
  }

  const shutdown = () => {
    sdk
      .shutdown()
      .catch((err) => console.error('[otel] error shutting down', err))
      .finally(() => process.exit(0));
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

export default sdk;
