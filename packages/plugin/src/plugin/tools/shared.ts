// Shared imports used across tool implementations.
//
// Goal: keep per-tool modules small and reduce “where does this come from?” friction
// for agents editing one tool at a time.

export { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
export { resolve, join } from "node:path";
export { homedir } from "node:os";

export { fetchBrowserCookies, fetchCapturedRequests } from "@getfoundry/unbrowse-core";
export {
  parseHar,
  generateSkill,
  SkillIndexClient,
  sanitizeApiTemplate,
  extractEndpoints,
  extractPublishableAuth,
  sanitizeHeaderProfile,
  resolveHeaders,
  primeHeaders,
  TokenRefreshScheduler,
  extractRefreshConfig,
  TaskWatcher,
  CapabilityResolver,
  DesktopAutomation,
  lookupCredentials,
  buildFormFields,
} from "@getfoundry/unbrowse-core";
export type {
  PublishPayload,
  HeaderProfileFile,
  RefreshConfig,
  TaskIntent,
  FailureInfo,
  Resolution,
  CredentialProvider,
  LoginCredential,
  PrimeResult,
} from "@getfoundry/unbrowse-core";
export { loginAndCapture } from "../../session-login.js";
export type { LoginCredentials } from "../../session-login.js";

export {
  LEARN_SCHEMA,
  CAPTURE_SCHEMA,
  AUTH_SCHEMA,
  REPLAY_SCHEMA,
  SKILLS_SCHEMA,
  PUBLISH_SCHEMA,
  SEARCH_SCHEMA,
  WALLET_SCHEMA,
  INTERACT_SCHEMA,
  LOGIN_SCHEMA,
  WORKFLOW_RECORD_SCHEMA,
  WORKFLOW_LEARN_SCHEMA,
  WORKFLOW_EXECUTE_SCHEMA,
  WORKFLOW_STATS_SCHEMA,
} from "../schemas.js";

export { toPascalCase } from "../naming.js";
