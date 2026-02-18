// Agent-browser backend package.
//
// This package intentionally contains shell execution (spawning `agent-browser`).
// It must not be bundled into the OpenClaw plugin package to avoid OpenClaw's
// dangerous-code scanner warnings.

export { runAgentBrowser, runAgentBrowserJson } from "./src/runner.js";
export { snapshotInteractive, type InteractiveElement } from "./src/snapshot.js";
export { captureHarFromAgentBrowser, type AgentBrowserHarOptions } from "./src/har.js";
export { loginWithAgentBrowser } from "./src/login-flow.js";
export { browseWithAgentBrowser } from "./src/browse-flow.js";

