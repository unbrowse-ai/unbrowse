// CDP_PRIMITIVES.md §three-planes — public surface: 3 planes + connection/chrome/target factories

export * from "./types.js";

export { connect, attach, call, close } from "./connection.js";
export { ensureChrome, spawnChrome, probeExistingCdp, getBrowserVersion } from "./chrome.js";
export {
  createBrowserContext,
  disposeBrowserContext,
  createTarget,
  attachToTarget,
  detachFromTarget,
  closeTarget,
  listTargets,
} from "./target.js";

export * as network from "./network/index.js";
export * as dom from "./dom/index.js";
export * as input from "./input/index.js";
export * as spoof from "./spoof/index.js";
export * as proxy from "./proxy/index.js";
