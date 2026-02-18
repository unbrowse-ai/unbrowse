export type ToolDeps = {
  // Core
  logger: any;
  pluginConfig?: any;
  /** Browser backend selector. Default: "openclaw" */
  browserBackend?: "openclaw" | "playwright" | "agent-browser";
  /** OpenClaw browser control port (only used when browserBackend="openclaw"). */
  browserPort: number;
  browserProfile?: string;
  allowLegacyPlaywrightFallback: boolean;
  defaultOutputDir: string;
  autoDiscoverEnabled: boolean;
  /**
   * Playwright config for browserBackend="playwright".
   * Keep this minimal and serializable (plugin config passes through OpenClaw).
   */
  playwright?: {
    channel?: string;
    headless?: boolean;
    userDataDir?: string;
    executablePath?: string;
  };

  // Feature flags
  enableChromeCookies: boolean;
  enableDesktopAutomation: boolean;
  publishValidationWithAuth: boolean;

  // Marketplace
  skillIndexUrl: string;
  indexClient: any;
  indexOpts: { indexUrl: string; creatorWallet?: string; solanaPrivateKey?: string };
  walletState: any;

  // Mutable wallet values mirrored for legacy code paths
  creatorWallet?: string;
  solanaPrivateKey?: string;

  // Auth/creds
  vaultDbPath: string;
  credentialProvider: any;

  // Auto-discovery
  discovery: any;
  autoPublishSkill: (service: string, skillDir: string) => Promise<string | null>;
  detectAndSaveRefreshConfig: (...args: any[]) => void;

  // Browser/session helpers (OpenClaw + Playwright fallback).
  // Optional for non-OpenClaw runtimes.
  getOrCreateBrowserSession?: (...args: any[]) => Promise<any>;

  // Shared browser/session state (needed for Playwright fallback behavior).
  getSharedBrowser?: () => any;
  closeChrome?: () => Promise<void>;
  browserSessions?: Map<string, any>;
};
