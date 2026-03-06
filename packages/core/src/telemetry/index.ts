import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

export interface TelemetryConfig {
  /** Service name reported to the collector. */
  serviceName?: string;
  /** Service version. */
  serviceVersion?: string;
  /** OTLP endpoint for traces (default: http://localhost:4318/v1/traces). */
  otlpTraceEndpoint?: string;
  /** OTLP endpoint for metrics (default: http://localhost:4318/v1/metrics). */
  otlpMetricEndpoint?: string;
  /** Metric export interval in milliseconds (default: 15000). */
  metricExportIntervalMs?: number;
  /** Whether to enable auto-instrumentation (default: true). */
  autoInstrumentation?: boolean;
}

let sdk: NodeSDK | null = null;

/**
 * Initialize OpenTelemetry with OTLP export and W3C TraceContext propagation.
 *
 * Call this once at application startup, before any other imports that
 * should be instrumented.
 */
export function initTelemetry(config: TelemetryConfig = {}): NodeSDK {
  if (sdk) {
    return sdk;
  }

  const {
    serviceName = 'honorclaw',
    serviceVersion = '0.1.0',
    otlpTraceEndpoint = process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] ?? 'http://localhost:4318/v1/traces',
    otlpMetricEndpoint = process.env['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'] ?? 'http://localhost:4318/v1/metrics',
    metricExportIntervalMs = 15_000,
    autoInstrumentation = true,
  } = config;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
  });

  const traceExporter = new OTLPTraceExporter({
    url: otlpTraceEndpoint,
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: otlpMetricEndpoint,
    }),
    exportIntervalMillis: metricExportIntervalMs,
  });

  sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader,
    textMapPropagator: new W3CTraceContextPropagator(),
    instrumentations: autoInstrumentation
      ? [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })]
      : [],
  });

  sdk.start();

  // Graceful shutdown
  process.on('SIGTERM', () => {
    sdk?.shutdown().catch(console.error);
  });

  return sdk;
}

/**
 * Shut down the OpenTelemetry SDK and flush pending exports.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
  }
}

export { startSessionSpan, startToolSpan, startLlmSpan, startGuardrailSpan } from './spans.js';
