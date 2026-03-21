import { Service, ServiceType, type IAgentRuntime } from "@elizaos/core";
import {
  resolveUnbrowseBin,
  runCommand,
  parseMaybeJson,
  getConfig,
} from "../shared";

export class UnbrowseService extends Service {
  static serviceType = ServiceType.BROWSER;

  private runtime: IAgentRuntime | null = null;

  static async start(runtime: IAgentRuntime): Promise<UnbrowseService> {
    const svc = new UnbrowseService();
    await svc.initialize(runtime);
    return svc;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const config = getConfig(runtime);
    const binPath = resolveUnbrowseBin(config);

    if (config.healthcheckOnStart) {
      try {
        const result = await runCommand(binPath, ["health"], config);
        if (!result.ok) {
          console.warn(
            `unbrowse: startup healthcheck failed: ${result.stderr || result.stdout}`
          );
        }
      } catch (error) {
        console.warn(`unbrowse: startup healthcheck threw: ${String(error)}`);
      }
    }
  }

  async getPageContent(
    url: string,
    _runtime?: IAgentRuntime
  ): Promise<{ title: string; description: string; bodyContent: string }> {
    const rt = _runtime ?? this.runtime;
    if (!rt) throw new Error("UnbrowseService not initialized");

    const config = getConfig(rt);
    const binPath = resolveUnbrowseBin(config);
    const args = [
      "resolve",
      "--intent",
      "extract page content",
      "--url",
      url,
    ];

    const result = await runCommand(binPath, args, config);
    const parsed = parseMaybeJson(result.stdout);
    const data =
      parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};

    return {
      title: typeof data.title === "string" ? data.title : "",
      description:
        typeof data.description === "string" ? data.description : "",
      bodyContent: result.ok
        ? JSON.stringify(parsed)
        : result.stderr || result.stdout,
    };
  }
}
