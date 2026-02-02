/* auto-generated type declarations for unbrowse-native */

// Core
export function getVersion(): string;
export function isNative(): boolean;
export function getModuleInfo(): {
  name: string;
  version: string;
  features: string[];
  platform: string;
  arch: string;
};

// Types
export interface HarHeader {
  name: string;
  value: string;
}

export interface HarCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
}

export interface HarPostData {
  mimeType?: string;
  text?: string;
}

export interface HarRequest {
  method: string;
  url: string;
  headers: HarHeader[];
  cookies?: HarCookie[];
  postData?: HarPostData;
}

export interface HarContent {
  size?: number;
  mimeType?: string;
  text?: string;
}

export interface HarResponse {
  status: number;
  headers: HarHeader[];
  content?: HarContent;
}

export interface HarEntry {
  request: HarRequest;
  response: HarResponse;
  startedDateTime?: string;
  time?: number;
}

export interface Har {
  log: { entries: HarEntry[] };
}

export interface ParsedRequest {
  method: string;
  url: string;
  path: string;
  domain: string;
  status: number;
  responseContentType?: string;
  fromSpec?: boolean;
  requestBody?: string;
  responseBody?: string;
}

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

export interface RefreshConfig {
  endpoint: string;
  method: string;
  body?: Record<string, string>;
  tokenPath?: string;
  expiresIn?: number;
}

export interface AuthJson {
  service: string;
  baseUrl: string;
  authMethod: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  context?: Record<string, string>;
  refresh?: RefreshConfig;
}

export interface SkillResult {
  service: string;
  skillDir: string;
  skillMdPath: string;
  authJsonPath: string;
  apiTsPath: string;
  endpointsCount: number;
  authMethod: string;
}

export interface SkillMeta {
  description?: string;
  author?: string;
  tags?: string[];
  priceUsdc?: number;
}

export interface EndpointInfo {
  method: string;
  path: string;
  description?: string;
  responseType?: string;
}

export interface LoginCredential {
  username: string;
  password: string;
  source?: string;
}

export interface VaultEntry {
  service: string;
  baseUrl: string;
  authMethod: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  updatedAt: string;
}

export interface BrowserRequest {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  status: number;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
}

export interface PageElement {
  index: number;
  tag: string;
  elementType?: string;
  role?: string;
  text?: string;
  placeholder?: string;
  href?: string;
  value?: string;
  name?: string;
  ariaLabel?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: PageElement[];
}

export interface SkillSummary {
  id: string;
  name: string;
  service: string;
  description?: string;
  author: string;
  authorWallet?: string;
  version: string;
  endpointsCount: number;
  installs: number;
  executions: number;
  priceUsdc?: number;
  tags?: string[];
  badge?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillPackage {
  id: string;
  skillMd: string;
  apiTs?: string;
  referenceMd?: string;
  authMethod: string;
  baseUrl: string;
  endpoints: EndpointInfo[];
}

export interface PublishPayload {
  service: string;
  skillMd: string;
  apiTs?: string;
  referenceMd?: string;
  authMethod: string;
  baseUrl: string;
  endpoints: EndpointInfo[];
  description?: string;
  tags?: string[];
  priceUsdc?: number;
}

export interface Wallet {
  pubkey: string;
  createdAt: string;
}

export interface EndpointTestResult {
  url: string;
  method: string;
  status: number;
  latencyMs: number;
  responseShape?: string;
  responseSize?: number;
  error?: string;
}

export interface RecordedStep {
  stepType: string;
  timestamp: string;
  url?: string;
  method?: string;
  status?: number;
  action?: string;
  selector?: string;
  value?: string;
}

export interface RecordedSession {
  id: string;
  startedAt: string;
  endedAt?: string;
  steps: RecordedStep[];
  domains: string[];
}

export interface VariableExtraction {
  name: string;
  source: string;
  jsonPath?: string;
  cssSelector?: string;
  regex?: string;
  headerName?: string;
}

export interface WorkflowStep {
  id: string;
  stepType: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  action?: string;
  selector?: string;
  value?: string;
  extractions?: VariableExtraction[];
  waitFor?: string;
  timeoutMs?: number;
}

export interface WorkflowSkill {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
}

export interface StepResult {
  stepId: string;
  success: boolean;
  latencyMs: number;
  status?: number;
  responseBody?: string;
  extractedVariables?: Record<string, string>;
  error?: string;
}

export interface WorkflowResult {
  workflowId: string;
  success: boolean;
  totalLatencyMs: number;
  stepsCompleted: number;
  stepsTotal: number;
  stepResults: StepResult[];
  finalVariables: Record<string, string>;
  error?: string;
}

// Parser functions
export function parseHar(harJson: string, seedUrl?: string): ApiData;
export function isThirdPartyDomain(domain: string): boolean;
export function detectAuthMethod(headers: Record<string, string>, cookies: Record<string, string>): string;
export function getServiceName(domain: string): string;
export function isAuthHeader(name: string): boolean;

// Auth functions
export function generateAuthJson(
  service: string,
  baseUrl: string,
  authMethod: string,
  authHeaders: Record<string, string>,
  cookies: Record<string, string>,
  authInfo: Record<string, string>
): AuthJson;
export function extractPublishableAuth(authJson: string): string;
export function detectRefreshEndpoint(
  url: string,
  method: string,
  requestBody?: string,
  responseBody?: string
): RefreshConfig | null;
export function extractRefreshConfig(harJson: string, authHeaders: Record<string, string>): RefreshConfig | null;

// Credential functions
export function lookupKeychain(domain: string): LoginCredential | null;
export function lookup1password(domain: string): LoginCredential | null;
export function lookupCredentials(domain: string): LoginCredential | null;
export function buildFormFields(credential: LoginCredential): Record<string, string>;

// Vault functions
export function vaultStore(
  service: string,
  baseUrl: string,
  authMethod: string,
  headers: Record<string, string>,
  cookies: Record<string, string>
): Promise<void>;
export function vaultGet(service: string): Promise<VaultEntry | null>;
export function vaultList(): Promise<string[]>;
export function vaultDelete(service: string): Promise<boolean>;
export function vaultExportAuthJson(service: string): Promise<string | null>;

// Skill functions
export function generateSkill(data: ApiData, outputDir?: string, meta?: SkillMeta): SkillResult;
export function listSkills(): string[];
export function getSkillInfo(service: string): SkillSummary | null;

// Sanitizer functions
export function sanitizeApiTemplate(apiTs: string): string;
export function extractEndpoints(skillMd: string): EndpointInfo[];
export function mergeEndpoints(existing: EndpointInfo[], newEndpoints: EndpointInfo[]): EndpointInfo[];
export function prepareForPublish(skillMd: string, apiTs?: string, authJson?: string): PublishPayload;

// Browser control functions
export function browserStatus(port?: number): Promise<boolean>;
export function browserStart(port?: number): Promise<boolean>;
export function browserNavigate(url: string, port?: number): Promise<boolean>;
export function browserSnapshot(port?: number): Promise<PageSnapshot>;
export function browserAct(action: string, elementIndex?: number, text?: string, port?: number): Promise<boolean>;
export function browserWait(condition: string, timeoutMs?: number, port?: number): Promise<boolean>;
export function browserGetRequests(filter?: string, clear?: boolean, port?: number): Promise<BrowserRequest[]>;
export function browserGetCookies(port?: number): Promise<Record<string, string>>;
export function browserGetLocalStorage(port?: number): Promise<Record<string, string>>;
export function browserGetSessionStorage(port?: number): Promise<Record<string, string>>;

// Capture functions
export function captureFromBrowser(seedUrl?: string, filter?: string, clear?: boolean, port?: number): Promise<ApiData>;
export function captureAndGenerateSkill(seedUrl: string, outputDir?: string, port?: number): Promise<SkillResult>;
export function captureFromUrls(urls: string[], port?: number): Promise<ApiData>;
export function extractBrowserAuth(domain: string, port?: number): Promise<AuthJson>;

// Chrome cookies
export function chromeCookiesAvailable(): boolean;
export function readChromeCookies(domain: string): Record<string, string>;
export function readChromeCookiesFull(domain: string): HarCookie[];

// Endpoint testing
export function testEndpoint(
  baseUrl: string,
  method: string,
  path: string,
  authHeaders: Record<string, string>,
  cookies: Record<string, string>,
  timeoutMs?: number
): Promise<EndpointTestResult>;
export function testGetEndpoints(
  baseUrl: string,
  endpoints: EndpointInfo[],
  authHeaders: Record<string, string>,
  cookies: Record<string, string>,
  concurrency?: number,
  timeoutMs?: number
): Promise<EndpointTestResult[]>;
export function validateAuth(
  baseUrl: string,
  testPath?: string,
  authHeaders?: Record<string, string>,
  cookies?: Record<string, string>
): Promise<boolean>;

// Marketplace functions
export function marketplaceSearch(query: string, baseUrl?: string): Promise<SkillSummary[]>;
export function marketplaceGetSkill(skillId: string, baseUrl?: string): Promise<SkillSummary | null>;
export function marketplaceTrending(baseUrl?: string): Promise<SkillSummary[]>;
export function marketplaceFeatured(baseUrl?: string): Promise<SkillSummary[]>;
export function marketplaceDownload(skillId: string, walletSignature?: string, baseUrl?: string): Promise<SkillPackage>;
export function marketplacePublish(payload: PublishPayload, walletPubkey: string, walletSignature: string, baseUrl?: string): Promise<SkillSummary>;
export function marketplaceTrackInstall(skillId: string, baseUrl?: string): Promise<void>;
export function marketplaceTrackExecution(skillId: string, success: boolean, latencyMs?: number, baseUrl?: string): Promise<void>;

// Wallet functions
export function walletCreate(): Wallet;
export function walletGet(): Wallet | null;
export function walletGetOrCreate(): Wallet;
export function walletSign(message: string): string;
export function walletSignPayment(skillId: string, priceUsdc: number, recipient: string): string;
export function walletVerify(message: string, signature: string, pubkey: string): boolean;
export function walletPubkey(): string | null;
export function walletDelete(): boolean;

// Workflow recording functions
export function recordingStart(): string;
export function recordingStop(): RecordedSession | null;
export function recordingNavigation(url: string): void;
export function recordingApiCall(url: string, method: string, status: number): void;
export function recordingAction(action: string, selector?: string, value?: string): void;
export function recordingIsActive(): boolean;
export function recordingCurrent(): RecordedSession | null;
export function recordingList(): string[];
export function recordingLoad(filename: string): RecordedSession;

// Workflow learning functions
export type WorkflowCategory = "ApiPackage" | "Workflow";
export function workflowCategorize(session: RecordedSession): WorkflowCategory;
export function workflowLearn(session: RecordedSession): WorkflowSkill;
export function workflowExtractVariables(responseBody: string, patterns: string[]): Record<string, string>;

// Workflow execution
export function workflowExecute(
  skill: WorkflowSkill,
  inputs?: Record<string, string>,
  authHeaders?: Record<string, string>,
  cookies?: Record<string, string>,
  browserPort?: number
): Promise<WorkflowResult>;
