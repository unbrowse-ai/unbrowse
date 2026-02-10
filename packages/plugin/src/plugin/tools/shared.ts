// Shared imports used across tool implementations.
//
// Goal: keep per-tool modules small and reduce “where does this come from?” friction
// for agents editing one tool at a time.

export { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
export { resolve, join } from "node:path";
export { homedir } from "node:os";

export { parseHar } from "../../har-parser.js";
export { generateSkill } from "../../skill-generator.js";
export { fetchBrowserCookies, fetchCapturedRequests } from "../../cdp-capture.js";
export { SkillIndexClient } from "../../skill-index.js";
export type { PublishPayload } from "../../skill-index.js";
export { sanitizeApiTemplate, extractEndpoints, extractPublishableAuth } from "../../skill-sanitizer.js";
export { loginAndCapture } from "../../session-login.js";
export type { LoginCredentials } from "../../session-login.js";
export { lookupCredentials, buildFormFields } from "../../credential-providers.js";
export type { CredentialProvider, LoginCredential } from "../../credential-providers.js";
export { TokenRefreshScheduler, extractRefreshConfig } from "../../token-refresh.js";
export type { RefreshConfig } from "../../token-refresh.js";
export { TaskWatcher } from "../../task-watcher.js";
export type { TaskIntent, FailureInfo } from "../../task-watcher.js";
export { CapabilityResolver } from "../../capability-resolver.js";
export type { Resolution } from "../../capability-resolver.js";
export { DesktopAutomation } from "../../desktop-automation.js";

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

