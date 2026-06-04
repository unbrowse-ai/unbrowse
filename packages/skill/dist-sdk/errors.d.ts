export declare class UnbrowseError extends Error {
    constructor(message: string);
}
export interface UnbrowseAPIErrorOptions {
    status: number;
    body: unknown;
    request_id?: string;
    url: string;
    method: string;
}
export declare class UnbrowseAPIError extends UnbrowseError {
    readonly status: number;
    readonly body: unknown;
    readonly request_id: string | undefined;
    readonly url: string;
    readonly method: string;
    constructor(message: string, opts: UnbrowseAPIErrorOptions);
}
export declare class UnbrowseAuthenticationError extends UnbrowseAPIError {
    constructor(message: string, opts: UnbrowseAPIErrorOptions);
}
export declare class UnbrowsePaymentRequiredError extends UnbrowseAPIError {
    constructor(message: string, opts: UnbrowseAPIErrorOptions);
}
export declare class UnbrowsePermissionError extends UnbrowseAPIError {
    constructor(message: string, opts: UnbrowseAPIErrorOptions);
}
export declare class UnbrowseNotFoundError extends UnbrowseAPIError {
    constructor(message: string, opts: UnbrowseAPIErrorOptions);
}
export declare class UnbrowseBadRequestError extends UnbrowseAPIError {
    constructor(message: string, opts: UnbrowseAPIErrorOptions);
}
export declare class UnbrowseRateLimitError extends UnbrowseAPIError {
    readonly retry_after_ms: number | undefined;
    constructor(message: string, opts: UnbrowseAPIErrorOptions & {
        retry_after_ms?: number;
    });
}
export declare class UnbrowseServerError extends UnbrowseAPIError {
    constructor(message: string, opts: UnbrowseAPIErrorOptions);
}
export declare class UnbrowseConnectionError extends UnbrowseError {
    readonly cause: unknown;
    constructor(message: string, cause: unknown);
}
export declare class UnbrowseTimeoutError extends UnbrowseConnectionError {
    constructor(message: string, cause: unknown);
}
export declare function errorFromStatus(opts: UnbrowseAPIErrorOptions & {
    retry_after_ms?: number;
}): UnbrowseAPIError;
