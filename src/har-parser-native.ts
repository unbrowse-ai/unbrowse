/**
 * HAR Parser — Native wrapper for the Rust-based HAR parser.
 *
 * This module provides a drop-in replacement for the TypeScript har-parser,
 * using the compiled native module for better performance and source protection.
 *
 * Falls back to TypeScript implementation if native module isn't available.
 */

import type { HarEntry, ParsedRequest, ApiData } from "./types.js";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Fallback imports (only used if native module unavailable)
import {
  parseHar as tsParseHar,
  mergeOpenApiEndpoints as tsMergeOpenApiEndpoints,
} from "./har-parser.js";
import { guessAuthMethod as tsGuessAuthMethod } from "./auth-extractor.js";

// Native module interface
interface NativeModule {
  parseHar: (harJson: string, seedUrl?: string | null) => {
    service: string;
    baseUrls: string[];
    baseUrl: string;
    authHeaders: Record<string, string>;
    authMethod: string;
    cookies: Record<string, string>;
    authInfo: Record<string, string>;
    requests: Array<{
      method: string;
      url: string;
      path: string;
      domain: string;
      status: number;
      responseContentType?: string;
      fromSpec?: boolean;
    }>;
    endpoints: Record<string, Array<{
      method: string;
      url: string;
      path: string;
      domain: string;
      status: number;
      responseContentType?: string;
      fromSpec?: boolean;
    }>>;
  };
  isThirdPartyDomain: (domain: string) => boolean;
  detectAuthMethod: (headers: Record<string, string>, cookies: Record<string, string>) => string;
  getServiceName: (domain: string) => string;
  isAuthHeader: (name: string) => boolean;
}

// Load native module
let nativeModule: NativeModule | null = null;
let useNative = false;

try {
  const require = createRequire(import.meta.url);
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // From dist/src/, native is at ../../native/
  const nativePath = join(__dirname, "..", "..", "native", "index.js");
  nativeModule = require(nativePath) as NativeModule;
  useNative = true;
} catch {
  // Native module not available, will use TypeScript fallback
}

/**
 * Parse a HAR file or HAR JSON object into structured API data.
 */
export function parseHar(har: { log: { entries: HarEntry[] } }, seedUrl?: string): ApiData {
  if (useNative && nativeModule) {
    const harJson = JSON.stringify(har);
    const result = nativeModule.parseHar(harJson, seedUrl);

    // Convert native result to match existing types
    return {
      service: result.service,
      baseUrls: result.baseUrls,
      baseUrl: result.baseUrl,
      authHeaders: result.authHeaders,
      authMethod: result.authMethod,
      cookies: result.cookies,
      authInfo: result.authInfo,
      requests: result.requests.map((req) => ({
        method: req.method,
        url: req.url,
        path: req.path,
        domain: req.domain,
        status: req.status,
        responseContentType: req.responseContentType,
        fromSpec: req.fromSpec,
      })),
      endpoints: Object.fromEntries(
        Object.entries(result.endpoints).map(([key, reqs]) => [
          key,
          reqs.map((req) => ({
            method: req.method,
            url: req.url,
            path: req.path,
            domain: req.domain,
            status: req.status,
            responseContentType: req.responseContentType,
            fromSpec: req.fromSpec,
          })),
        ])
      ),
    };
  }

  // Fallback to TypeScript implementation
  return tsParseHar(har, seedUrl);
}

/**
 * Check if a domain should be filtered out (third-party analytics, etc.)
 */
export function isThirdPartyDomain(domain: string): boolean {
  if (useNative && nativeModule) {
    return nativeModule.isThirdPartyDomain(domain);
  }
  // No TS fallback needed - this is informational only
  return false;
}

/**
 * Detect the authentication method from headers and cookies.
 */
export function guessAuthMethod(
  authHeaders: Record<string, string>,
  cookies: Record<string, string>
): string {
  if (useNative && nativeModule) {
    return nativeModule.detectAuthMethod(authHeaders, cookies);
  }
  return tsGuessAuthMethod(authHeaders, cookies);
}

/**
 * Extract the service name from a domain.
 */
export function getServiceName(domain: string): string {
  if (useNative && nativeModule) {
    return nativeModule.getServiceName(domain);
  }
  // Simple fallback
  return domain
    .replace(/^(www|api)\./, "")
    .replace(/\.(com|org|net|io|ai|app)$/, "")
    .replace(/\./g, "-");
}

/**
 * Check if a header name looks like an auth header.
 */
export function isAuthHeader(name: string): boolean {
  if (useNative && nativeModule) {
    return nativeModule.isAuthHeader(name);
  }
  // Simple fallback
  const lower = name.toLowerCase();
  return (
    lower.includes("auth") ||
    lower.includes("token") ||
    lower.includes("key") ||
    lower.includes("session")
  );
}

/**
 * Merge OpenAPI spec endpoints into existing API data.
 */
export function mergeOpenApiEndpoints(
  apiData: ApiData,
  openApiEndpoints: { method: string; path: string; summary?: string }[],
  baseUrl: string
): ApiData {
  // This is simple logic - just use the TypeScript version
  return tsMergeOpenApiEndpoints(apiData, openApiEndpoints, baseUrl);
}

/**
 * Check if native module is being used.
 */
export function isUsingNative(): boolean {
  return useNative;
}
