/** Canonical Unbrowse domain types — unbrowse/v1alpha1. */

export const API_VERSION = "unbrowse/v1alpha1" as const;
export const BUILD_DIGEST = "unbrowse-build-2026.09.22.p1";

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
export type EffectClass =
  | "read_only"
  | "safely_repeatable"
  | "upstream_deduplicated"
  | "reconcile_before_retry"
  | "non_repeatable";
export type TransportKind = "browser" | "first_party_http" | "hybrid";
export type RequirementKind =
  | "data"
  | "choice"
  | "authentication"
  | "verification"
  | "approval"
  | "unsupported";
export type RequirementAction = "accept" | "decline" | "clear";
export type ProofState = "available" | "possibly_consumed" | "consumed" | "expired";
export type CapabilityLifecycle =
  | "observed"
  | "candidate"
  | "validated"
  | "published"
  | "quarantined"
  | "retired";
export type Visibility = "workspace_private" | "public_registry" | "shared";
export type DeploymentProfile =
  | "personal_cloud"
  | "enterprise_dedicated"
  | "hybrid_private"
  | "fully_private";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type Expr =
  | { op: "literal"; value: Json }
  | { op: "ref"; path: string }
  | { op: "all"; items: Expr[] }
  | { op: "any"; items: Expr[] }
  | { op: "not"; item: Expr }
  | { op: "eq"; items: Expr[] }
  | { op: "exists"; path: string }
  | { op: "is_fresh"; path: string };

export type EvalTri = "true" | "false" | "unknown";

export type SlotDef = {
  name: string;
  schema: Record<string, Json>;
  sources: string[];
  requiredFor: string[];
  typeName?: string;
  choicesFrom?: string;
  contextGroup?: string;
  sensitivity?: "none" | "pii" | "secret";
  lifetime?: "run" | "account" | "page" | "expiring" | "single_use";
};

export type BindingDef = {
  name: string;
  producer: { kind: "slot" | "output" | "resolve_resource"; ref: string; pointer?: string };
  consumers: { operation: string; inputPointer: string }[];
  scope: "run" | "context_generation";
  contextGroup?: string;
  callerWritable: boolean;
  sensitivity?: "none" | "secret";
};

export type OperationDef = {
  id: string;
  packageId: string;
  inputs: Record<string, { ref: string }>;
  guard?: Expr;
  invalidateWhen?: string[];
  effectClass: EffectClass;
  writes: string[];
  reconciliation?: string;
  timeoutMs: number;
  repeat?: {
    until: Expr;
    maxIterations: number;
    deadlineMs: number;
    stopOn: string[];
    backoffPolicy: string;
  };
  implementations: ImplementationDef[];
  outputSchema: Record<string, Json>;
};

export type ImplementationDef = {
  id: string;
  kind: TransportKind;
  eligibility: string;
  requestTemplate?: string;
  actionPackage?: string;
  pinnedBuild?: string;
};

export type OutcomeCheck = { path: string; equals?: Json; exists?: boolean };

export type HarnessPackage = {
  apiVersion: typeof API_VERSION;
  kind: "CapabilityHarness";
  metadata: {
    id: string;
    revision: number;
    visibility: Visibility;
    title: string;
    description: string;
    skillYaml: string;
  };
  spec: {
    goal: Expr;
    interaction: { missingInput: "suspend"; unansweredPolicy: string };
    budget: { maxOperations: number; maxRecoveryAttempts: number };
    slots: SlotDef[];
    bindings: BindingDef[];
    operations: OperationDef[];
    result: Record<string, { ref: string }>;
    policy: {
      requiredGrants: string[];
      destinations: string[];
      discovery: string;
      riskCeiling: "low" | "medium" | "high";
    };
    outcomeChecks: OutcomeCheck[];
  };
  lockfile: { digest: string; operations: string[]; runtime: string };
};

export type CompatibilityKey = {
  capabilityId: string;
  harnessRevision: number;
  implementationId: string;
  buildDigest: string;
  site: string;
  authMode: string;
};

export type CompatibilityRecord = CompatibilityKey & {
  status: "works" | "unknown" | "excluded";
  reason?: string;
  evidenceRefs: string[];
};

export type Workspace = {
  id: string;
  userId: string;
  profile: DeploymentProfile;
  allowExternalInference: boolean;
  policyVersion: number;
  createdAt: number;
  /** Auto-share learned read-only routes to the public registry (opt-out; default on). */
  shareLearned?: boolean;
  /** Public ids this workspace has already promoted (dedup). */
  promotedPublic?: string[];
  /** The signed-in person's email (from the edge sign-in) and when they were last active — admin view only. */
  email?: string;
  lastSeenAt?: number;
};

export type Principal = {
  id: string;
  workspaceId: string;
  kind: "user" | "agent";
  label: string;
  revoked: boolean;
};

export type Grant = {
  id: string;
  workspaceId: string;
  principalId: string;
  classes: string[];
  destinations: string[];
  revoked: boolean;
  resourceSet?: string;
  amountLimit?: number;
  contextGeneration?: number;
  actionDigest?: string;
  expiresAt?: number;
};

export type AccountBinding = {
  id: string;
  workspaceId: string;
  origin: string;
  label: string;
  ownerPrincipalId: string;
  permittedPrincipalIds: string[];
  credentialRef: string;
  ready: boolean;
  authMode: "none" | "session" | "password" | "oauth";
  organization?: string;
  description: string;
};

export type CapabilityRecord = {
  id: string;
  workspaceId: string | null;
  visibility: Visibility;
  lifecycle: CapabilityLifecycle;
  harness: HarnessPackage;
  implementations: ImplementationDef[];
  description: string;
  origin: string;
  firstParty: boolean;
  passworded: boolean;
  readiness: "ready" | "requires_authentication" | "interactive_only";
  health: Record<string, "healthy" | "cooldown" | "quarantined" | "unknown">;
};

export type SlotValue = {
  name: string;
  value: Json;
  generation: number;
  source: string;
  fresh: boolean;
  sensitivity: "none" | "pii" | "secret";
};

export type BindingValue = {
  name: string;
  value: Json;
  generation: number;
  producerPath: string;
  evidenceRef?: string;
  stale: boolean;
};

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

export type Artifact = {
  id: string;
  workspaceId: string;
  digest: string;
  mimeType: string;
  size: number;
  purpose: string;
  bytesB64: string;
  ownerRunId: string;
  expiresAt: number;
};

export type RunRequest = {
  capability?: string;
  task?: string;
  targetUrl?: string;
  input?: Record<string, Json>;
  accountRefs?: string[];
  interactionMode?: InteractionMode;
  authorizationRef?: string;
  idempotencyKey: string;
  allowedDestinations?: string[];
  budget?: { maxOperations?: number };
  executionPlane?: DeploymentProfile;
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

export type CaptureRecord = {
  id: string;
  runId: string;
  kind: "action" | "network" | "screenshot" | "coverage";
  actionId?: string;
  method?: string;
  url?: string;
  status?: number;
  sanitized: Record<string, Json>;
  coverage: "complete" | "partial" | "missing";
  truncated?: boolean;
  sensitive: boolean;
  quarantined: boolean;
};

export type AuthContext = {
  workspaceId: string;
  principalId: string;
  userId: string;
  apiKeyId?: string;
};

export type EngineError = {
  status: number;
  code: string;
  message: string;
  details?: Record<string, Json>;
};

export class UnbrowseError extends Error {
  status: number;
  code: string;
  details?: Record<string, Json>;
  constructor(status: number, code: string, message: string, details?: Record<string, Json>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
