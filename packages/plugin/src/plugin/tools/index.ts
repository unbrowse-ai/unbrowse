import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk";

import type { ToolDeps } from "./deps.js";

import { makeUnbrowseLearnTool } from "./unbrowse_learn.js";
import { makeUnbrowseCaptureTool } from "./unbrowse_capture.js";
import { makeUnbrowseAuthTool } from "./unbrowse_auth.js";
import { makeUnbrowseReplayTool } from "./unbrowse_replay.js";
import { makeUnbrowseSkillsTool } from "./unbrowse_skills.js";
import { makeUnbrowsePublishTool } from "./unbrowse_publish.js";
import { makeUnbrowseSearchTool } from "./unbrowse_search.js";
import { makeUnbrowseLoginTool } from "./unbrowse_login.js";
import { makeUnbrowseWalletTool } from "./unbrowse_wallet.js";
import { makeUnbrowseBrowseTool } from "./unbrowse_browse.js";
import { makeUnbrowseDoTool } from "./unbrowse_do.js";
import { makeUnbrowseDesktopTool } from "./unbrowse_desktop.js";
import { makeUnbrowseWorkflowRecordTool } from "./unbrowse_workflow_record.js";
import { makeUnbrowseWorkflowLearnTool } from "./unbrowse_workflow_learn.js";
import { makeUnbrowseWorkflowExecuteTool } from "./unbrowse_workflow_execute.js";
import { makeUnbrowseWorkflowStatsTool } from "./unbrowse_workflow_stats.js";

export type { ToolDeps } from "./deps.js";

export function createTools(deps: ToolDeps) {
  return (_ctx: OpenClawPluginToolContext) => {
    const toolList = [
      makeUnbrowseLearnTool(deps),
      makeUnbrowseCaptureTool(deps),
      makeUnbrowseAuthTool(deps),
      makeUnbrowseReplayTool(deps),
      makeUnbrowseSkillsTool(deps),
      makeUnbrowsePublishTool(deps),
      makeUnbrowseSearchTool(deps),
      makeUnbrowseLoginTool(deps),
      makeUnbrowseWalletTool(deps),
      makeUnbrowseBrowseTool(deps),
      makeUnbrowseDoTool(deps),
      makeUnbrowseDesktopTool(deps),
      makeUnbrowseWorkflowRecordTool(deps),
      makeUnbrowseWorkflowLearnTool(deps),
      makeUnbrowseWorkflowExecuteTool(deps),
      makeUnbrowseWorkflowStatsTool(deps),
    ];

    return toolList as any;
  };
}
