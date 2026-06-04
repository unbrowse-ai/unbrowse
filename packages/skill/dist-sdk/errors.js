// Typed error hierarchy. Mirrors OpenAI / Stripe conventions so `instanceof`
// checks read naturally for calling agents. Every error carries the request_id
// when the server returned one, so users can paste it into support.
export class UnbrowseError extends Error {
    constructor(message) {
        super(message);
        this.name = "UnbrowseError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
export class UnbrowseAPIError extends UnbrowseError {
    status;
    body;
    request_id;
    url;
    method;
    constructor(message, opts) {
        super(message);
        this.name = "UnbrowseAPIError";
        this.status = opts.status;
        this.body = opts.body;
        this.request_id = opts.request_id;
        this.url = opts.url;
        this.method = opts.method;
    }
}
export class UnbrowseAuthenticationError extends UnbrowseAPIError {
    constructor(message, opts) {
        super(message, opts);
        this.name = "UnbrowseAuthenticationError";
    }
}
export class UnbrowsePaymentRequiredError extends UnbrowseAPIError {
    // 402 — surfaces x402 sponsor exhaustion / wallet top-up requirement.
    // body is the x402 payment requirements object the server returned.
    constructor(message, opts) {
        super(message, opts);
        this.name = "UnbrowsePaymentRequiredError";
    }
}
export class UnbrowsePermissionError extends UnbrowseAPIError {
    constructor(message, opts) {
        super(message, opts);
        this.name = "UnbrowsePermissionError";
    }
}
export class UnbrowseNotFoundError extends UnbrowseAPIError {
    constructor(message, opts) {
        super(message, opts);
        this.name = "UnbrowseNotFoundError";
    }
}
export class UnbrowseBadRequestError extends UnbrowseAPIError {
    constructor(message, opts) {
        super(message, opts);
        this.name = "UnbrowseBadRequestError";
    }
}
export class UnbrowseRateLimitError extends UnbrowseAPIError {
    retry_after_ms;
    constructor(message, opts) {
        super(message, opts);
        this.name = "UnbrowseRateLimitError";
        this.retry_after_ms = opts.retry_after_ms;
    }
}
export class UnbrowseServerError extends UnbrowseAPIError {
    constructor(message, opts) {
        super(message, opts);
        this.name = "UnbrowseServerError";
    }
}
export class UnbrowseConnectionError extends UnbrowseError {
    cause;
    constructor(message, cause) {
        super(message);
        this.name = "UnbrowseConnectionError";
        this.cause = cause;
    }
}
export class UnbrowseTimeoutError extends UnbrowseConnectionError {
    constructor(message, cause) {
        super(message, cause);
        this.name = "UnbrowseTimeoutError";
    }
}
export function errorFromStatus(opts) {
    const msg = extractMessage(opts.body) ?? `HTTP ${opts.status} from ${opts.method} ${opts.url}`;
    switch (opts.status) {
        case 400: return new UnbrowseBadRequestError(msg, opts);
        case 401: return new UnbrowseAuthenticationError(msg, opts);
        case 402: return new UnbrowsePaymentRequiredError(msg, opts);
        case 403: return new UnbrowsePermissionError(msg, opts);
        case 404: return new UnbrowseNotFoundError(msg, opts);
        case 429: return new UnbrowseRateLimitError(msg, opts);
    }
    if (opts.status >= 500)
        return new UnbrowseServerError(msg, opts);
    return new UnbrowseAPIError(msg, opts);
}
function extractMessage(body) {
    if (!body || typeof body !== "object")
        return undefined;
    const b = body;
    if (typeof b.error === "string")
        return b.error;
    if (typeof b.message === "string")
        return b.message;
    const inner = b.error;
    if (inner && typeof inner === "object" && "message" in inner) {
        const m = inner.message;
        if (typeof m === "string")
            return m;
    }
    return undefined;
}
