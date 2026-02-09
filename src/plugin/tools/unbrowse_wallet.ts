import { createWalletTool } from "../../wallet/wallet-tool.js";
import { WALLET_SCHEMA } from "../schemas.js";
import type { ToolDeps } from "./deps.js";

export function makeUnbrowseWalletTool(deps: ToolDeps) {
  const { logger, walletState, indexOpts } = deps;

  return createWalletTool({
    schema: WALLET_SCHEMA,
    logger,
    walletState,
    indexOpts,
  });
}
