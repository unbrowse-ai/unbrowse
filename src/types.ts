/** Raw HAR entry from a HAR file or CDP capture. */
export interface HarEntry {
  request: {
    method: string;
    url: string;
    headers: { name: string; value: string }[];
    cookies?: { name: string; value: string }[];
    queryString?: { name: string; value: string }[];
    postData?: { mimeType?: string; text?: string };
  };
  response: {
    status: number;
    headers: { name: string; value: string }[];
    content?: { size?: number; mimeType?: string; text?: string };
  };
  time?: number;
}

/** Parsed request info (simplified from HAR). */
export interface ParsedRequest {
  method: string;
  url: string;
  path: string;
  domain: string;
  status: number;
  /** Whether this endpoint was verified by auto-test */
  verified?: boolean;
  /** From OpenAPI spec rather than traffic capture */
  fromSpec?: boolean;
  /** Resource type from Playwright/CDP capture (e.g., "xhr", "fetch", "document") */
  resourceType?: string;
  /** Response content-type header */
  responseContentType?: string;
}

/** Auth credentials extracted from traffic. */
export interface AuthInfo {
  service: string;
  baseUrl: string;
  authMethod: string;
  timestamp: string;
  notes: string[];
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  mudraToken?: string;
  userId?: string;
  outletIds?: string[];
  authInfo?: Record<string, string>;
}

/** Full parsed API data from HAR analysis. */
export interface ApiData {
  service: string;
  baseUrls: string[];
  baseUrl: string;
  authHeaders: Record<string, string>;
  authMethod: string;
  cookies: Record<string, string>;
  authInfo: Record<string, string>;
  requests: ParsedRequest[];
  endpoints: Record<string, ParsedRequest[]>;
}

/** Result of skill generation. */
export interface SkillResult {
  skillFile: string;
  skillDir: string;
  service: string;
  authMethod: string;
  endpointCount: number;
  authHeaderCount: number;
  cookieCount: number;
  testPassed?: boolean;
  verifiedEndpoints?: number;
  unverifiedEndpoints?: number;
  openApiSource?: string | null;
  pagesCrawled?: number;
  /** Whether the skill content changed from the previous version. */
  changed: boolean;
  /** Human-readable diff summary (e.g. "+3 new endpoint(s)"). */
  diff?: string | null;
  /** SHA-256 hash (first 8 chars) of skill content for version tracking. */
  versionHash?: string;
}

/** CDP network request from browser control API. */
export interface CdpNetworkEntry {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  resourceType?: string;
  timestamp?: number;
}
