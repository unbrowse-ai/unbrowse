import type { X402PaymentRequirement } from "./x402.js";

export class UnbrowseApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly data: unknown;
  readonly headers: Headers;

  constructor(message: string, options: { status: number; path: string; data: unknown; headers: Headers }) {
    super(message);
    this.name = "UnbrowseApiError";
    this.status = options.status;
    this.path = options.path;
    this.data = options.data;
    this.headers = options.headers;
  }
}

/**
 * Thrown when the backend returns 402 Payment Required with a parsable
 * x402 `accepts` array. Day 4 wires a `payAndRetry` helper that consumes
 * this error + a wallet and replays the request with an `X-PAYMENT` header.
 */
export class PaymentRequiredError extends UnbrowseApiError {
  readonly accepts: X402PaymentRequirement[];
  readonly resourceUrl: string;
  readonly skillId?: string;

  constructor(
    message: string,
    accepts: X402PaymentRequirement[],
    resourceUrl: string,
    skillId?: string,
  ) {
    super(message, {
      status: 402,
      path: resourceUrl,
      data: { accepts, resourceUrl, skillId },
      headers: new Headers(),
    });
    this.name = "PaymentRequiredError";
    this.accepts = accepts;
    this.resourceUrl = resourceUrl;
    this.skillId = skillId;
  }
}

/**
 * Thrown when the platform sponsor wallet would normally cover the call
 * but the per-agent or global cap is exhausted (or no wallet is configured).
 * Caller can still pay directly via `payAndRetry` using the carried `accepts`.
 */
export class SponsorExhaustedError extends PaymentRequiredError {
  readonly reason: "agent_cap" | "global_cap" | "no_wallet";
  readonly remainingCreditUsd: number;

  constructor(
    message: string,
    accepts: X402PaymentRequirement[],
    resourceUrl: string,
    reason: "agent_cap" | "global_cap" | "no_wallet",
    remainingCreditUsd: number,
    skillId?: string,
  ) {
    super(message, accepts, resourceUrl, skillId);
    this.name = "SponsorExhaustedError";
    this.reason = reason;
    this.remainingCreditUsd = remainingCreditUsd;
  }
}

/**
 * Thrown when the SDK cannot locate, spawn, or reach a local `unbrowse`
 * runtime. The `cause` field discriminates whether the failure was
 * spawn-time, probe-time, or because no binary was found on disk.
 */
export class RuntimeUnavailableError extends UnbrowseApiError {
  readonly cause: "spawn_failed" | "probe_failed" | "binary_missing";
  readonly attemptedPort?: number;

  constructor(
    message: string,
    cause: "spawn_failed" | "probe_failed" | "binary_missing",
    attemptedPort?: number,
  ) {
    super(message, {
      status: 0,
      path: attemptedPort ? `http://127.0.0.1:${attemptedPort}` : "<runtime>",
      data: { cause, attemptedPort },
      headers: new Headers(),
    });
    this.name = "RuntimeUnavailableError";
    this.cause = cause;
    this.attemptedPort = attemptedPort;
  }
}
