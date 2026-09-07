// CDP_PRIMITIVES.md §process-model + §statelessness-invariants — shared types

// import type { Client } from 'chrome-remote-interface';

/**
 * A live CDP WebSocket connection to a single Chrome browser process.
 * AsyncDisposable so `using conn = await connect(...)` tears down on scope exit.
 */
export interface CDPConnection extends AsyncDisposable {
  /** Raw chrome-remote-interface Client handle (typed loosely here to avoid runtime import). */
  readonly client: unknown;
  /** Path to the Chrome binary that produced this connection. */
  readonly chromeBin: string;
  /** PID of the Chrome process. */
  readonly pid: number;
  /** ws:// endpoint of the browser-level CDP target. */
  readonly endpoint: string;
  /** Chrome version triple reported by Browser.getVersion. */
  readonly version: string;
  /** Product revision (for fingerprint pin assertions). */
  readonly revision: string;
  /** Send a raw CDP method call. */
  call<TParams = unknown, TResult = unknown>(method: string, params?: TParams, sessionId?: string): Promise<TResult>;
  /** Subscribe to a CDP event. Returns unsubscribe. */
  on(event: string, handler: (params: unknown, sessionId?: string) => void): () => void;
  /** Close the WS + signal Chrome to shut down (SIGTERM via Browser.close). */
  close(): Promise<void>;
}

/**
 * A separate cookie-jar / storage partition within a single Chrome process.
 * Created via Target.createBrowserContext (incognito-equivalent).
 */
export interface BrowserContext {
  readonly cdp: CDPConnection;
  readonly browserContextId: string;
  /** Per-context proxy chain (set via --proxy-server=per-context at launch). */
  readonly proxyServer?: string;
  readonly proxyBypassList?: string;
}

/**
 * A single tab/target inside a BrowserContext. The unit of session isolation.
 * sessionId is the flat-multiplexing handle used on every method call.
 */
export interface Target {
  readonly cdp: CDPConnection;
  readonly browserContextId?: string;
  readonly targetId: string;
  readonly sessionId: string;
  readonly type: "page" | "background_page" | "service_worker" | "worker" | "iframe" | "other";
}

/** Chrome launch flags surfaced as primitive params. */
export interface ChromeLaunchOptions {
  /** Path to chrome binary; if omitted, ensureChrome() resolves via @puppeteer/browsers cache. */
  chromeBin?: string;
  /** --user-data-dir; if omitted a fresh ephemeral dir is created. */
  userDataDir?: string;
  /** --headless=new by default; set false for a visible window. */
  headless?: boolean;
  /** Global launch-time proxy (use per-context proxies instead when possible). */
  proxy?: string;
  /** Extra raw flags appended to argv. */
  extraArgs?: string[];
  /** --proxy-server=per-context when true (default); enables per-BrowserContext proxy. */
  perContextProxy?: boolean;
  /**
   * Persist Chrome across this process's exit (browse-session mode). Spawns
   * Chrome DETACHED + unref'd via raw child_process so the parent's
   * `process.exit()` does not reap it (puppeteer's launch always registers an
   * exit-kill hook), and reads the DevTools endpoint from Chrome's own
   * `DevToolsActivePort` file. This is what lets `act go` in one CLI call be
   * re-attached by a SEPARATE `eval snap` / `act click` / `act close` call.
   */
  persist?: boolean;
}

// ─── L-network types ────────────────────────────────────────────────────────

export interface CDPCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  url?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
  priority?: "Low" | "Medium" | "High";
  sameParty?: boolean;
  sourceScheme?: "Unset" | "NonSecure" | "Secure";
}

export interface FetchRequestPattern {
  urlPattern?: string;
  resourceType?: string;
  requestStage?: "Request" | "Response";
}

export interface FetchRequest {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  };
  resourceType: string;
  frameId?: string;
  networkId?: string;
}

export interface UserAgentMetadata {
  brands?: Array<{ brand: string; version: string }>;
  fullVersionList?: Array<{ brand: string; version: string }>;
  platform?: string;
  platformVersion?: string;
  architecture?: string;
  model?: string;
  mobile?: boolean;
  bitness?: string;
  wow64?: boolean;
}

export interface NetworkRequestWillBeSentEvent {
  requestId: string;
  loaderId: string;
  documentURL: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  };
  timestamp: number;
  wallTime: number;
  initiator: unknown;
  type?: string;
}

export interface NetworkResponseReceivedEvent {
  requestId: string;
  loaderId: string;
  timestamp: number;
  type: string;
  response: {
    url: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
    remoteIPAddress?: string;
  };
}

export interface NetworkLoadingFinishedEvent {
  requestId: string;
  timestamp: number;
  encodedDataLength: number;
}

// ─── L-DOM types ────────────────────────────────────────────────────────────

export type NodeId = number;
export type BackendNodeId = number;
export type RemoteObjectId = string;
export type FrameId = string;

export interface DOMNode {
  nodeId: NodeId;
  backendNodeId: BackendNodeId;
  nodeType: number;
  nodeName: string;
  localName: string;
  nodeValue: string;
  childNodeCount?: number;
  children?: DOMNode[];
  attributes?: string[];
  frameId?: FrameId;
  shadowRoots?: DOMNode[];
}

export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  description?: { type: string; value: string };
  value?: { type: string; value: unknown };
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>;
  childIds?: string[];
  backendDOMNodeId?: BackendNodeId;
}

export interface BoxModel {
  content: number[];
  padding: number[];
  border: number[];
  margin: number[];
  width: number;
  height: number;
}

export interface RuntimeEvaluateOptions {
  expression: string;
  awaitPromise?: boolean;
  returnByValue?: boolean;
  contextId?: number;
  userGesture?: boolean;
  silent?: boolean;
  generatePreview?: boolean;
}

export interface RuntimeEvaluateResult {
  result: {
    type: string;
    value?: unknown;
    objectId?: RemoteObjectId;
    description?: string;
  };
  exceptionDetails?: unknown;
}

// ─── L-input types ──────────────────────────────────────────────────────────

export type MouseEventType = "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
export type MouseButton = "none" | "left" | "middle" | "right" | "back" | "forward";

export interface MouseEventParams {
  type: MouseEventType;
  x: number;
  y: number;
  button?: MouseButton;
  clickCount?: number;
  modifiers?: number;
  deltaX?: number;
  deltaY?: number;
}

export type KeyEventType = "keyDown" | "keyUp" | "rawKeyDown" | "char";

export interface KeyEventParams {
  type: KeyEventType;
  key?: string;
  code?: string;
  text?: string;
  unmodifiedText?: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
  modifiers?: number;
}

export interface TouchPoint {
  x: number;
  y: number;
  radiusX?: number;
  radiusY?: number;
  rotationAngle?: number;
  force?: number;
  id?: number;
}

export interface TouchEventParams {
  type: "touchStart" | "touchEnd" | "touchMove" | "touchCancel";
  touchPoints: TouchPoint[];
  modifiers?: number;
}

export interface DragData {
  items: Array<{ mimeType: string; data: string; title?: string; baseURL?: string }>;
  files?: string[];
  dragOperationsMask: number;
}

export interface DragEventParams {
  type: "dragEnter" | "dragOver" | "drop" | "dragCancel";
  x: number;
  y: number;
  data: DragData;
  modifiers?: number;
}

// ─── Spoof / proxy ──────────────────────────────────────────────────────────

export interface ProxyConfig {
  /** e.g. "http://geo.iproyal.com:12321" */
  server: string;
  /** Optional bypass patterns. */
  bypassList?: string;
  /** Username for proxy auth (satisfied via Fetch.continueWithAuth). */
  username?: string;
  /** Password for proxy auth. */
  password?: string;
  /** Country lock for iproyal (encoded into URL). */
  country?: string;
}

export interface SpoofInitScript {
  /** Deterministic identifier returned by Page.addScriptToEvaluateOnNewDocument. */
  identifier: string;
  /** sha256 of source for drift detection. */
  sourceSha: string;
}
