export interface BrowserAccessConfig {
  default_path: "unbrowse" | "direct" | "proxy";
  fallback_path: "direct" | "proxy";
  supported_frameworks: string[];
}

export const DEFAULT_BROWSER_ACCESS: BrowserAccessConfig = {
  default_path: "unbrowse",
  fallback_path: "direct",
  supported_frameworks: ["openclaw", "mcp", "langchain", "hermes", "elizaos"],
};
