import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from "@elizaos/core";
import {
  resolveUnbrowseBin,
  runCommand,
  buildArgs,
  parseMaybeJson,
  summarizeOutput,
  getConfig,
  hasErrorPayload,
  type ToolParams,
} from "../shared";

export const unbrowseAction: Action = {
  name: "UNBROWSE_FETCH",
  similes: [
    "FETCH_URL",
    "WEB_SEARCH",
    "GET_DATA_FROM_WEBSITE",
    "EXTRACT_DATA",
    "API_DISCOVERY",
    "BROWSE_WEBSITE",
  ],
  description:
    "Fetch structured data from any website using Unbrowse API discovery. Prefer this over BROWSER_NAVIGATE for data extraction, search, and authenticated reads.",

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    options: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    const config = getConfig(runtime);
    const binPath = resolveUnbrowseBin(config);

    const params: ToolParams = {
      action:
        (options.action as ToolParams["action"]) ?? "resolve",
      intent:
        (options.intent as string) ?? message.content.text ?? "",
      url: options.url as string | undefined,
      domain: options.domain as string | undefined,
      skillId: options.skillId as string | undefined,
      endpointId: options.endpointId as string | undefined,
      path: options.path as string | undefined,
      extract: options.extract as string | undefined,
      limit: options.limit as number | undefined,
      pretty: options.pretty as boolean | undefined,
      confirmUnsafe: options.confirmUnsafe as boolean | undefined,
      dryRun: options.dryRun as boolean | undefined,
    };

    try {
      const args = buildArgs(params);
      const result = await runCommand(binPath, args, config);
      const parsed = parseMaybeJson(result.stdout);
      const failed = !result.ok || hasErrorPayload(parsed);

      if (callback) {
        await callback({
          text: !failed
            ? summarizeOutput(result.stdout)
            : `Unbrowse failed: ${result.stderr || summarizeOutput(result.stdout)}`,
          data: parsed,
        });
      }

      return !failed;
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : String(error);
      if (callback) {
        await callback({
          text: `Unbrowse invocation failed: ${msg}`,
        });
      }
      return false;
    }
  },

  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Get me the latest papers from arxiv about LLMs",
        },
      },
      {
        user: "{{agent}}",
        content: {
          text: "Fetching from arxiv via Unbrowse...",
          action: "UNBROWSE_FETCH",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Search for flight prices from NYC to London",
        },
      },
      {
        user: "{{agent}}",
        content: {
          text: "Searching for flight prices via Unbrowse...",
          action: "UNBROWSE_FETCH",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Extract product listings from this Amazon page",
        },
      },
      {
        user: "{{agent}}",
        content: {
          text: "Extracting product data via Unbrowse API discovery...",
          action: "UNBROWSE_FETCH",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "What APIs does this website use?",
        },
      },
      {
        user: "{{agent}}",
        content: {
          text: "Discovering APIs via Unbrowse...",
          action: "UNBROWSE_FETCH",
        },
      },
    ],
  ],
};
