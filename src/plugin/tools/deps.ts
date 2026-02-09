export type ToolDeps = {
  // Core
  logger: any;
  browserPort: number;
  defaultOutputDir: string;
  autoDiscoverEnabled: boolean;

  // Feature flags
  enableChromeCookies: boolean;
  enableOtpAutoFill: boolean;
  enableDesktopAutomation: boolean;

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

  // Browser/session helpers provided by plugin runtime
  getOrCreateBrowserSession: (...args: any[]) => Promise<any>;
  startPersistentOtpWatcher: (...args: any[]) => Promise<void>;
  isOtpWatcherActive: () => boolean;

  // Shared browser/session state (needed for Playwright fallback behavior).
  getSharedBrowser: () => any;
  closeChrome: () => Promise<void>;
  browserSessions: Map<string, any>;
};

