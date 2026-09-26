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
