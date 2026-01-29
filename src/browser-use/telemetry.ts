/**
 * Browser-Use TypeScript Port - Telemetry Service
 *
 * Production observability with spans, metrics, and structured logging.
 * Tracks agent performance, LLM calls, action execution, and errors.
 *
 * Features:
 * - Hierarchical spans for tracing
 * - Metrics collection (counters, histograms, gauges)
 * - Structured logging with context
 * - Performance profiling
 * - Error classification and reporting
 */

/**
 * Span status
 */
export type SpanStatus = "ok" | "error" | "timeout" | "cancelled";

/**
 * Metric types
 */
export type MetricType = "counter" | "histogram" | "gauge";

/**
 * Log levels
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Span data for tracing
 */
export interface Span {
  id: string;
  name: string;
  parentId?: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: SpanStatus;
  attributes: Record<string, any>;
  events: Array<{ name: string; timestamp: number; attributes?: Record<string, any> }>;
}

/**
 * Metric data point
 */
export interface MetricPoint {
  name: string;
  type: MetricType;
  value: number;
  timestamp: number;
  labels: Record<string, string>;
}

/**
 * Structured log entry
 */
export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: number;
  spanId?: string;
  attributes: Record<string, any>;
}

/**
 * Telemetry event handler
 */
export interface TelemetryHandler {
  onSpanEnd?: (span: Span) => void;
  onMetric?: (metric: MetricPoint) => void;
  onLog?: (entry: LogEntry) => void;
}

/**
 * Telemetry configuration
 */
export interface TelemetryConfig {
  /** Service name for attribution */
  serviceName?: string;
  /** Enable console output */
  consoleOutput?: boolean;
  /** Minimum log level */
  logLevel?: LogLevel;
  /** Custom handlers */
  handlers?: TelemetryHandler[];
  /** Sample rate for spans (0-1) */
  sampleRate?: number;
  /** Max spans to keep in memory */
  maxSpans?: number;
  /** Max metrics to keep in memory */
  maxMetrics?: number;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Generate unique ID
 */
function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Telemetry Service - Production observability
 */
export class TelemetryService {
  private config: Required<TelemetryConfig>;
  private spans: Span[] = [];
  private metrics: MetricPoint[] = [];
  private logs: LogEntry[] = [];
  private activeSpans = new Map<string, Span>();
  private spanStack: string[] = [];
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, number[]>();

  constructor(config: TelemetryConfig = {}) {
    this.config = {
      serviceName: config.serviceName ?? "browser-use",
      consoleOutput: config.consoleOutput ?? true,
      logLevel: config.logLevel ?? "info",
      handlers: config.handlers ?? [],
      sampleRate: config.sampleRate ?? 1.0,
      maxSpans: config.maxSpans ?? 1000,
      maxMetrics: config.maxMetrics ?? 10000,
    };
  }

  // =================== SPANS ===================

  /**
   * Start a new span
   */
  startSpan(name: string, attributes: Record<string, any> = {}): string {
    // Sample rate check
    if (Math.random() > this.config.sampleRate) {
      return "";
    }

    const id = generateId();
    const parentId = this.spanStack[this.spanStack.length - 1];

    const span: Span = {
      id,
      name,
      parentId,
      startTime: Date.now(),
      status: "ok",
      attributes: {
        service: this.config.serviceName,
        ...attributes,
      },
      events: [],
    };

    this.activeSpans.set(id, span);
    this.spanStack.push(id);

    return id;
  }

  /**
   * Add event to current span
   */
  addSpanEvent(name: string, attributes?: Record<string, any>): void {
    const spanId = this.spanStack[this.spanStack.length - 1];
    if (!spanId) return;

    const span = this.activeSpans.get(spanId);
    if (!span) return;

    span.events.push({
      name,
      timestamp: Date.now(),
      attributes,
    });
  }

  /**
   * Set span attribute
   */
  setSpanAttribute(key: string, value: any): void {
    const spanId = this.spanStack[this.spanStack.length - 1];
    if (!spanId) return;

    const span = this.activeSpans.get(spanId);
    if (!span) return;

    span.attributes[key] = value;
  }

  /**
   * End a span
   */
  endSpan(spanId: string, status: SpanStatus = "ok", error?: Error): void {
    if (!spanId) return;

    const span = this.activeSpans.get(spanId);
    if (!span) return;

    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.status = status;

    if (error) {
      span.attributes.error = error.message;
      span.attributes.errorStack = error.stack;
    }

    // Remove from active and stack
    this.activeSpans.delete(spanId);
    const stackIndex = this.spanStack.indexOf(spanId);
    if (stackIndex !== -1) {
      this.spanStack.splice(stackIndex, 1);
    }

    // Store completed span
    this.spans.push(span);
    if (this.spans.length > this.config.maxSpans) {
      this.spans.shift();
    }

    // Notify handlers
    for (const handler of this.config.handlers) {
      handler.onSpanEnd?.(span);
    }

    // Console output
    if (this.config.consoleOutput) {
      const statusIcon = status === "ok" ? "✓" : status === "error" ? "✗" : "⚠";
      console.log(`[${this.config.serviceName}] ${statusIcon} ${span.name} (${span.duration}ms)`);
    }
  }

  /**
   * Execute function within a span
   */
  async withSpan<T>(
    name: string,
    fn: () => Promise<T>,
    attributes: Record<string, any> = {}
  ): Promise<T> {
    const spanId = this.startSpan(name, attributes);
    try {
      const result = await fn();
      this.endSpan(spanId, "ok");
      return result;
    } catch (err) {
      this.endSpan(spanId, "error", err as Error);
      throw err;
    }
  }

  /**
   * Get current span ID
   */
  getCurrentSpanId(): string | undefined {
    return this.spanStack[this.spanStack.length - 1];
  }

  // =================== METRICS ===================

  /**
   * Increment a counter
   */
  incrementCounter(name: string, value = 1, labels: Record<string, string> = {}): void {
    const key = this.metricKey(name, labels);
    const current = this.counters.get(key) ?? 0;
    this.counters.set(key, current + value);

    this.recordMetric(name, "counter", current + value, labels);
  }

  /**
   * Set a gauge value
   */
  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.metricKey(name, labels);
    this.gauges.set(key, value);

    this.recordMetric(name, "gauge", value, labels);
  }

  /**
   * Record a histogram value
   */
  recordHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.metricKey(name, labels);
    const values = this.histograms.get(key) ?? [];
    values.push(value);
    this.histograms.set(key, values);

    this.recordMetric(name, "histogram", value, labels);
  }

  /**
   * Get histogram statistics
   */
  getHistogramStats(name: string, labels: Record<string, string> = {}): {
    count: number;
    sum: number;
    avg: number;
    min: number;
    max: number;
    p50: number;
    p90: number;
    p99: number;
  } | null {
    const key = this.metricKey(name, labels);
    const values = this.histograms.get(key);
    if (!values || values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);

    return {
      count: values.length,
      sum,
      avg: sum / values.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p90: sorted[Math.floor(sorted.length * 0.9)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  }

  private metricKey(name: string, labels: Record<string, string>): string {
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return `${name}{${labelStr}}`;
  }

  private recordMetric(
    name: string,
    type: MetricType,
    value: number,
    labels: Record<string, string>
  ): void {
    const point: MetricPoint = {
      name,
      type,
      value,
      timestamp: Date.now(),
      labels: { service: this.config.serviceName, ...labels },
    };

    this.metrics.push(point);
    if (this.metrics.length > this.config.maxMetrics) {
      this.metrics.shift();
    }

    for (const handler of this.config.handlers) {
      handler.onMetric?.(point);
    }
  }

  // =================== LOGGING ===================

  /**
   * Log at debug level
   */
  debug(message: string, attributes: Record<string, any> = {}): void {
    this.log("debug", message, attributes);
  }

  /**
   * Log at info level
   */
  info(message: string, attributes: Record<string, any> = {}): void {
    this.log("info", message, attributes);
  }

  /**
   * Log at warn level
   */
  warn(message: string, attributes: Record<string, any> = {}): void {
    this.log("warn", message, attributes);
  }

  /**
   * Log at error level
   */
  error(message: string, error?: Error, attributes: Record<string, any> = {}): void {
    this.log("error", message, {
      ...attributes,
      error: error?.message,
      stack: error?.stack,
    });
  }

  private log(level: LogLevel, message: string, attributes: Record<string, any>): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.logLevel]) {
      return;
    }

    const entry: LogEntry = {
      level,
      message,
      timestamp: Date.now(),
      spanId: this.getCurrentSpanId(),
      attributes: { service: this.config.serviceName, ...attributes },
    };

    this.logs.push(entry);

    for (const handler of this.config.handlers) {
      handler.onLog?.(entry);
    }

    if (this.config.consoleOutput) {
      const prefix = `[${this.config.serviceName}]`;
      const attrStr = Object.keys(attributes).length > 0
        ? ` ${JSON.stringify(attributes)}`
        : "";

      switch (level) {
        case "debug":
          console.debug(`${prefix} ${message}${attrStr}`);
          break;
        case "info":
          console.info(`${prefix} ${message}${attrStr}`);
          break;
        case "warn":
          console.warn(`${prefix} ${message}${attrStr}`);
          break;
        case "error":
          console.error(`${prefix} ${message}${attrStr}`);
          break;
      }
    }
  }

  // =================== AGENT-SPECIFIC METRICS ===================

  /**
   * Record step execution
   */
  recordStep(step: number, duration: number, success: boolean): void {
    this.recordHistogram("agent.step.duration", duration, { step: String(step) });
    this.incrementCounter("agent.step.total", 1, { success: String(success) });
  }

  /**
   * Record action execution
   */
  recordAction(action: string, duration: number, success: boolean): void {
    this.recordHistogram("agent.action.duration", duration, { action });
    this.incrementCounter("agent.action.total", 1, { action, success: String(success) });
  }

  /**
   * Record LLM call
   */
  recordLLMCall(provider: string, duration: number, tokens?: number, success?: boolean): void {
    this.recordHistogram("llm.call.duration", duration, { provider });
    this.incrementCounter("llm.call.total", 1, { provider, success: String(success ?? true) });
    if (tokens) {
      this.incrementCounter("llm.tokens.total", tokens, { provider });
    }
  }

  /**
   * Record navigation
   */
  recordNavigation(url: string, duration: number): void {
    const domain = new URL(url).hostname;
    this.recordHistogram("browser.navigation.duration", duration, { domain });
    this.incrementCounter("browser.navigation.total", 1, { domain });
  }

  /**
   * Record error
   */
  recordError(errorType: string, action?: string): void {
    this.incrementCounter("agent.error.total", 1, { type: errorType, action: action ?? "unknown" });
  }

  // =================== EXPORT ===================

  /**
   * Get all spans
   */
  getSpans(): Span[] {
    return [...this.spans];
  }

  /**
   * Get all metrics
   */
  getMetrics(): MetricPoint[] {
    return [...this.metrics];
  }

  /**
   * Get all logs
   */
  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  /**
   * Export telemetry summary
   */
  getSummary(): {
    spans: { total: number; errors: number; avgDuration: number };
    metrics: Record<string, any>;
    errors: number;
  } {
    const completedSpans = this.spans.filter(s => s.duration !== undefined);
    const errorSpans = completedSpans.filter(s => s.status === "error");
    const avgDuration = completedSpans.length > 0
      ? completedSpans.reduce((sum, s) => sum + (s.duration ?? 0), 0) / completedSpans.length
      : 0;

    return {
      spans: {
        total: completedSpans.length,
        errors: errorSpans.length,
        avgDuration: Math.round(avgDuration),
      },
      metrics: {
        stepStats: this.getHistogramStats("agent.step.duration"),
        actionStats: this.getHistogramStats("agent.action.duration"),
        llmStats: this.getHistogramStats("llm.call.duration"),
      },
      errors: errorSpans.length,
    };
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.spans = [];
    this.metrics = [];
    this.logs = [];
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

/**
 * Default telemetry instance
 */
export const defaultTelemetry = new TelemetryService();

/**
 * Decorator for tracing methods
 */
export function traced(name?: string) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    const spanName = name || `${target.constructor.name}.${propertyKey}`;

    descriptor.value = async function (...args: any[]) {
      return defaultTelemetry.withSpan(spanName, () => originalMethod.apply(this, args));
    };

    return descriptor;
  };
}
