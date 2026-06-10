import type { Provider, IAgentRuntime, Memory } from "@elizaos/core";

export const unbrowseRoutingProvider: Provider = {
  get: async (runtime: IAgentRuntime, _message: Memory): Promise<string> => {
    const mode = runtime.getSetting?.("UNBROWSE_ROUTING_MODE") ?? "strict";

    const lines = [
      "Web-routing policy:",
      "- Use UNBROWSE_FETCH first for website data extraction, search, authenticated reads, and API discovery.",
      "- Use BROWSER_NAVIGATE only for visual QA, file uploads, drag-drop, canvas apps, or when Unbrowse has no usable path.",
    ];

    if (mode === "strict") {
      lines.push(
        "- Strict mode is on. Avoid BROWSER_NAVIGATE for normal website work."
      );
    }

    return lines.join("\n");
  },
};
