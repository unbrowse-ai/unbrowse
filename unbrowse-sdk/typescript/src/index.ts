export { UnbrowseNode, type UnbrowseNodeOptions } from "./client.js";
// The familiar name: `new Unbrowse()` reads UNBROWSE_AGENT_TOKEN and UNBROWSE_NODE, as `new OpenAI()` reads its key.
export { UnbrowseNode as Unbrowse, type UnbrowseNodeOptions as UnbrowseOptions } from "./client.js";
export { UnbrowseOwner, EventStream, type UnbrowseOwnerOptions } from "./owner.js";
export {
  UnbrowseError,
  BadRequestError,
  AuthenticationError,
  PaymentRequiredError,
  PermissionDeniedError,
  NotFoundError,
  ConflictError,
  UnprocessableEntityError,
  BrowserMissingError,
  NodeUnavailableError,
  NodeConnectionError,
  NodeTimeoutError,
  DEFAULT_NODE,
} from "./http.js";
export { Browser, type BrowserOptions, type SnapshotOptions, type WaitFor, type GetWhat } from "./browser.js";
export type { StartOptions } from "./start.js";
/** How a client checks the node before a token goes to it (`/v1/node/proof`): for a client of your own. */
export { nodeProof, tokenKey, keccak256 } from "./proof.js";
export type * from "./types.js";
export type * from "./owner-types.js";
// The node's records as they cross the wire, in its own snake case, generated from its agent-api.json: `wire.DoResult`.
export type * as wire from "./generated.js";
export { OwnerCommands } from "./generated.js";

import { UnbrowseNode as Default } from "./client.js";
export default Default;
