/**
 * Credential Providers — opt-in login credential lookup.
 *
 * Security hardening: OS CLI-backed providers are disabled in this build to avoid
 * shell execution in published marketplace packages.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface LoginCredential {
  username: string;
  password: string;
  url?: string;
  label?: string;
  source: "keychain" | "1password" | "vault";
}

export interface CredentialProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  lookup(domain: string): Promise<LoginCredential[]>;
  store?(domain: string, username: string, password: string): Promise<void>;
}

// ── Disabled providers (shell-free build) ───────────────────────────────────

export class KeychainProvider implements CredentialProvider {
  name = "keychain";

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async lookup(_domain: string): Promise<LoginCredential[]> {
    return [];
  }

  async store(_domain: string, _username: string, _password: string): Promise<void> {
    throw new Error("Keychain credential provider is disabled in this build.");
  }
}

export class OnePasswordProvider implements CredentialProvider {
  name = "1password";

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async lookup(_domain: string): Promise<LoginCredential[]> {
    return [];
  }
}

// ── Local Vault Provider ─────────────────────────────────────────────────────

export class VaultCredentialProvider implements CredentialProvider {
  name = "vault";
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async isAvailable(): Promise<boolean> {
    const { existsSync } = await import("node:fs");
    return existsSync(this.dbPath);
  }

  async lookup(domain: string): Promise<LoginCredential[]> {
    const results: LoginCredential[] = [];

    try {
      const { Vault } = await import("./vault.js");
      const vault = new Vault(this.dbPath);

      const entry = vault.get(domain);
      if (entry?.extra?.username && entry?.extra?.password) {
        results.push({
          username: entry.extra.username,
          password: entry.extra.password,
          url: entry.baseUrl,
          label: `Vault: ${domain}`,
          source: "vault",
        });
      }

      const shortDomain = domain.replace(/\.(com|io|org|net|dev|co|ai|app)$/, "");
      if (shortDomain !== domain) {
        const entry2 = vault.get(shortDomain);
        if (entry2?.extra?.username && entry2?.extra?.password) {
          results.push({
            username: entry2.extra.username,
            password: entry2.extra.password,
            url: entry2.baseUrl,
            label: `Vault: ${shortDomain}`,
            source: "vault",
          });
        }
      }

      vault.close();
    } catch {
      // Vault not initialized or key not found
    }

    return results;
  }

  async store(domain: string, username: string, password: string): Promise<void> {
    try {
      const { Vault } = await import("./vault.js");
      const vault = new Vault(this.dbPath);

      vault.store(domain, {
        baseUrl: `https://${domain}`,
        authMethod: "login",
        extra: { username, password },
      });

      vault.close();
    } catch {
      // Vault not available
    }
  }
}

// ── Provider Factory ─────────────────────────────────────────────────────────

export function createCredentialProvider(
  source: string | undefined,
  vaultDbPath?: string,
): CredentialProvider | null {
  switch (source) {
    case "keychain":
      return new KeychainProvider();
    case "1password":
      return new OnePasswordProvider();
    case "vault":
      if (!vaultDbPath) return null;
      return new VaultCredentialProvider(vaultDbPath);
    case "auto":
      return new AutoDetectProvider(vaultDbPath);
    case "none":
    default:
      return null;
  }
}

class AutoDetectProvider implements CredentialProvider {
  name = "auto";
  private resolved: CredentialProvider | null | undefined = undefined;
  private vaultDbPath?: string;

  constructor(vaultDbPath?: string) {
    this.vaultDbPath = vaultDbPath;
  }

  private async resolve(): Promise<CredentialProvider | null> {
    if (this.resolved !== undefined) return this.resolved;

    const candidates: CredentialProvider[] = [];
    if (this.vaultDbPath) {
      candidates.push(new VaultCredentialProvider(this.vaultDbPath));
    }

    for (const provider of candidates) {
      try {
        if (await provider.isAvailable()) {
          this.resolved = provider;
          this.name = `auto:${provider.name}`;
          return provider;
        }
      } catch {
        // skip unavailable provider
      }
    }

    this.resolved = null;
    return null;
  }

  async isAvailable(): Promise<boolean> {
    const provider = await this.resolve();
    return provider != null;
  }

  async lookup(domain: string): Promise<LoginCredential[]> {
    const provider = await this.resolve();
    if (!provider) return [];
    return provider.lookup(domain);
  }

  async store(domain: string, username: string, password: string): Promise<void> {
    const provider = await this.resolve();
    if (provider?.store) {
      await provider.store(domain, username, password);
    }
  }
}

export async function lookupCredentials(
  provider: CredentialProvider,
  url: string,
): Promise<LoginCredential | null> {
  try {
    const hostname = new URL(url).hostname;
    let creds = await provider.lookup(hostname);
    if (creds.length > 0) return creds[0];

    if (hostname.startsWith("www.")) {
      creds = await provider.lookup(hostname.slice(4));
      if (creds.length > 0) return creds[0];
    }

    const parts = hostname.split(".");
    if (parts.length > 2) {
      const baseDomain = parts.slice(-2).join(".");
      creds = await provider.lookup(baseDomain);
      if (creds.length > 0) return creds[0];
    }

    return null;
  } catch {
    return null;
  }
}

export function buildFormFields(cred: LoginCredential): Record<string, string> {
  return {
    'input[type="email"], input[name="email"], input[name="username"], input[name="login"], input[id="email"], input[id="username"], input[id="login"], input[autocomplete="username"], input[autocomplete="email"]':
      cred.username,
    'input[type="password"], input[name="password"], input[id="password"], input[autocomplete="current-password"]':
      cred.password,
  };
}
