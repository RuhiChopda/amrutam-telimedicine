/**
 * OpenTelemetry bootstrap. Imported FIRST by main.ts/worker.ts so http/pg/ioredis are instrumented before they load.
 * Active only when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise tracing is a no-op with zero overhead.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: process.env.SERVICE_NAME ?? 'amrutam-api' }),
    traceExporter: new OTLPTraceExporter({ url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (r) => ['/healthz', '/readyz', '/metrics'].includes(r.url ?? '') }),
      // db.statement is kept (parameterised SQL only; values are bind params and are never recorded)
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new IORedisInstrumentation({ dbStatementSerializer: (cmd) => cmd }),
    ],
  });
  sdk.start();
}

export const shutdownTracing = async (): Promise<void> => {
  await sdk?.shutdown().catch(() => undefined);
};
