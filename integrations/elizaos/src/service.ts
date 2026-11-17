import { Service, logger, type IAgentRuntime } from "@elizaos/core";
import { UnbrowseNode } from "unbrowse";

/** A setting from the character's secrets/settings or runtime; absent when empty. */
function setting(runtime: IAgentRuntime, key: string): string | undefined {
  const v = runtime.getSetting(key);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * The Unbrowse node, held for the agent. Its key comes only from the character or runtime's own settings; the shared
 * process environment is never used as a key fallback. `UNBROWSE_NODE` defaults to http://127.0.0.1:7788. Settings are read each time they're needed, so
 * a token set after the agent started turns the actions on, as the warning at the start says. The client keeps one
 * browsing session, through a changed token too, so each UNBROWSE_BROWSE step acts on the page the last one opened.
 */
export class UnbrowseService extends Service {
  static serviceType = "unbrowse";
  capabilityDescription = "Calls websites through the Unbrowse node on this machine: the site's own API, learned once by the node's browser.";

  private client: UnbrowseNode;
  /** The settings `client` was made with. */
  private made: string;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    const { token, baseUrl } = this.settings();
    this.client = new UnbrowseNode({ token, baseUrl });
    this.made = JSON.stringify([token, baseUrl]);
  }

  private settings(): { token?: string; baseUrl?: string } {
    const runtime = this.runtime as IAgentRuntime | undefined;
    return {
      token: runtime ? setting(runtime, "UNBROWSE_AGENT_TOKEN") : undefined,
      baseUrl: runtime && setting(runtime, "UNBROWSE_NODE"),
    };
  }

  /** The client for the settings as they are now. */
  get node(): UnbrowseNode {
    const { token, baseUrl } = this.settings();
    const now = JSON.stringify([token, baseUrl]);
    if (now !== this.made) {
      this.client = new UnbrowseNode({ token, baseUrl, session: this.client.session });
      this.made = now;
    }
    return this.client;
  }

  /** The agent has a token, so the node will take its calls. */
  get ready(): boolean {
    return !!this.settings().token;
  }

  static async start(runtime: IAgentRuntime): Promise<UnbrowseService> {
    const service = new UnbrowseService(runtime);
    if (!service.ready) {
      logger.warn("Unbrowse: no agent token. Set UNBROWSE_AGENT_TOKEN (`unbrowse agent token` prints it); its actions stay off until then.");
    }
    return service;
  }

  async stop(): Promise<void> {
    // The client holds no connection: nothing to close.
  }
}

/** The service, when the plugin is loaded and has a token. */
export function unbrowse(runtime: IAgentRuntime): UnbrowseService | null {
  const s = runtime.getService<UnbrowseService>(UnbrowseService.serviceType);
  return s?.ready ? s : null;
}
