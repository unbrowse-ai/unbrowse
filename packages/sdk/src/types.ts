// Public shapes of the Unbrowse REST API, trimmed from unbrowse6 src/lib/unbrowse/types.ts.

export const API_VERSION = "unbrowse/v1alpha1" as const;

export type RunStatus =
  | "accepted"
  | "working"
  | "input_required"
  | "succeeded"
  | "failed"
  | "outcome_unknown"
  | "cancelled"
  | "expired";

export type InteractionMode = "interactive" | "unattended" | "external_handler";

export type RequirementKind =
  | "data"
  | "choice"
  | "authentication"
  | "verification"
  | "approval"
  | "unsupported";

export type RequirementAction = "accept" | "decline" | "clear";

export type CapabilityLifecycle =
  | "observed"
  | "candidate"
  | "validated"
  | "published"
  | "quarantined"
  | "retired";

export type DeploymentProfile =
  | "personal_cloud"
  | "enterprise_dedicated"
  | "hybrid_private"
  | "fully_private";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type Requirement = {
  id: string;
  revision: number;
  kind: RequirementKind;
  reason: string;
  affectedAction: string;
  schema: Record<string, Json>;
  sourceAuthority: string[];
  sensitivity: "none" | "pii" | "secret";
  optionsSnapshot?: string;
  options?: { id: string; label: string; value: Json }[];
  expiration: number;
  state: "open" | "answered" | "declined" | "superseded" | "expired";
  interactionUrl?: string;
};

export type RequirementAnswer = {
  requirementId: string;
  expectedRevision: number;
  action: RequirementAction;
  values?: Record<string, Json>;
  idempotencyKey: string;
};

export type KnownEffect = {
  operation: string;
  state: "unstarted" | "dispatched" | "confirmed" | "rejected" | "uncertain";
  resourceRef?: string;
  intentId: string;
};

export type RunRequest = {
  capability?: string;
  task?: string;
  targetUrl?: string;
  input?: Record<string, Json>;
  accountRefs?: string[];
  interactionMode?: InteractionMode;
  authorizationRef?: string;
  /** Optional: the server makes one when absent. */
  idempotencyKey?: string;
  allowedDestinations?: string[];
  budget?: { maxOperations?: number };
  executionPlane?: DeploymentProfile;
  /** `client`: you send the site requests from your own IP (see `Unbrowse.runOnClient`). Default `server`. */
  egress?: "server" | "client";
};

/** A site request for you to send, in a client-egress run. */
export type EgressRequest = {
  /** Answer with this as `requestId`. */
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  bodyEncoding?: "text" | "base64";
  /** `manual`: do not follow redirects; return the 3xx as it came. */
  redirect: "follow" | "manual";
  /** The same request as a curl command. */
  curl: string;
};

/** A client-egress run waiting for you to send its next site request(s). */
export type EgressStep = { status: "egress_required"; egressId: string; requests: EgressRequest[] };

/** The site's response to one request, as you got it. */
export type EgressResponse = {
  status: number;
  /** `[name, value]` pairs keep repeated headers (set-cookie). */
  headers?: [string, string][] | Record<string, string | string[]>;
  /** Decoded body (after gzip/brotli): text, or base64 with `bodyEncoding: "base64"`. Up to 10 MB. */
  body?: string;
  bodyEncoding?: "text" | "base64";
  /** The final URL, if you followed redirects. */
  url?: string;
};

export type RunView = {
  runId: string;
  workspaceId: string;
  principalId: string;
  status: RunStatus;
  phase: string;
  stateRevision: number;
  capabilityId?: string;
  harnessRevision?: number;
  requirements: Requirement[];
  result: Record<string, Json> | null;
  error: { code: string; message: string } | null;
  knownEffects: KnownEffect[];
  cost: { calls: number; browserMs: number; inference: number; passthrough?: { value: number; currency: string } };
  verified: boolean;
  evidenceRefs: string[];
  routingExplanation: string[];
  candidateSkill?: { id: string; lifecycle: CapabilityLifecycle };
  events: RunEvent[];
  /** "http": replayed over first-party HTTP. "rendered": a page was rendered (own browser or a hosted renderer). */
  via?: "http" | "rendered";
  renderedBy?: { renderer: string; url: string; fallbackFrom?: string; cost?: { value: number; currency: string } };
  /** The site needs a sign-in and no login is saved: a one-time Unbrowse page where the person saves it. */
  signIn?: { url: string; requestId: string; origin: string; message: string };
};

export type RunEventType =
  | "RunAccepted"
  | "PackagePinned"
  | "DecisionRecorded"
  | "BindingResolved"
  | "BindingInvalidated"
  | "RequirementIssued"
  | "RequirementAnswered"
  | "OperationIntentRecorded"
  | "DispatchStarted"
  | "ObservationRecorded"
  | "OutcomeVerified"
  | "CaptureRecorded"
  | "CandidateCompiled"
  | "QuarantineIssued"
  | "RunFinalized";

export type RunEvent = {
  eventId: string;
  runId: string;
  workspaceId: string;
  seq: number;
  type: RunEventType;
  at: number;
  actor: string;
  build: string;
  payload: Record<string, Json>;
};

export type ScrapeFormat = "markdown" | "html" | "text" | "links" | "raw";

/** `POST /scrape`: one page. `deadlineMs` is clamped to 5000–120000 (default 45000). */
export type ScrapeRequest = {
  url: string;
  formats?: ScrapeFormat[];
  /** Drop navigation, headers, footers and asides (default true). */
  onlyMainContent?: boolean;
  render?: "auto" | "always" | "never";
  /** Exit country for the HTTP fetch: a two-letter ISO code or GLOBAL. */
  country?: string;
  deadlineMs?: number;
};

export type ScrapeResult = {
  markdown?: string;
  html?: string;
  text?: string;
  links?: string[];
  raw?: string;
  metadata: { url: string; finalUrl: string; status?: number; title?: string; description?: string; [k: string]: Json | undefined };
  [k: string]: unknown;
};

/** An index job (`POST /index`): done means `status: "done"` and `indexed > 0`. */
export type IndexJob = {
  id: string;
  url: string;
  host: string;
  status: "queued" | "running" | "done" | "failed";
  /** Browserless tools it proved. */
  indexed?: number;
  capabilities?: Array<{ id?: string; name?: string; verified?: boolean; browserless?: boolean; [k: string]: Json | undefined }>;
  stoppedReason?: string;
  summary?: string;
  error?: { code: string; message: string };
  /** The site's tools: `GET` this path (no account). */
  site?: string;
  [k: string]: unknown;
};
