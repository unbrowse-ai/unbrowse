/**
 * Credential Providers — Opt-in login credential lookup from external sources.
 *
 * Supports three backends:
 *   1. macOS Keychain — `security find-internet-password` for Safari/system-saved passwords
 *   2. 1Password CLI — `op item list/get` for 1Password vault items
 *   3. Local Vault — Encrypted SQLite storage (same vault as API auth, separate table)
 *
 * All providers are opt-in via the `credentialSource` plugin config.
 * The agent never sees raw passwords — they flow directly into Playwright form fills.
 */

import { execSync, exec } from "node:child_process";

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
  /** Check if this provider's CLI/backend is available. */
  isAvailable(): Promise<boolean>;
  /** Look up login credentials matching a domain (e.g. "github.com"). */
  lookup(domain: string): Promise<LoginCredential[]>;
  /** Store a credential (optional — not all providers support this). */
  store?(domain: string, username: string, password: string): Promise<void>;
}

// ── macOS Keychain Provider ──────────────────────────────────────────────────

export class KeychainProvider implements CredentialProvider {
  name = "keychain";

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    try {
      execSync("which security", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  async lookup(domain: string): Promise<LoginCredential[]> {
    const results: LoginCredential[] = [];

    // Try internet passwords (Safari, Chrome saved passwords synced to Keychain)
    try {
      const output = execSync(
        `security find-internet-password -s "${shellEscape(domain)}" -g 2>&1`,
        { encoding: "utf-8", timeout: 5000 },
      );

      const username = extractKeychainField(output, '"acct"');
      const password = extractKeychainPassword(output);

      if (username && password) {
        results.push({
          username,
          password,
          url: `https://${domain}`,
          label: `Keychain: ${domain}`,
          source: "keychain",
        });
      }
    } catch {
      // No internet password for this domain
    }

    // Also try with www. prefix if the domain doesn't have one
    if (!domain.startsWith("www.")) {
      try {
        const output = execSync(
          `security find-internet-password -s "www.${shellEscape(domain)}" -g 2>&1`,
          { encoding: "utf-8", timeout: 5000 },
        );

        const username = extractKeychainField(output, '"acct"');
        const password = extractKeychainPassword(output);

        if (username && password) {
          results.push({
            username,
            password,
            url: `https://www.${domain}`,
            label: `Keychain: www.${domain}`,
            source: "keychain",
          });
        }
      } catch {
        // No internet password for www. variant
      }
    }

    return results;
  }

  async store(domain: string, username: string, password: string): Promise<void> {
    try {
      // Delete existing entry first (upsert)
      execSync(
        `security delete-internet-password -s "${shellEscape(domain)}" -a "${shellEscape(username)}" 2>/dev/null`,
        { stdio: "ignore", timeout: 5000 },
      ).toString();
    } catch {
      // May not exist yet
    }

    execSync(
      `security add-internet-password -s "${shellEscape(domain)}" -a "${shellEscape(username)}" -w "${shellEscape(password)}"`,
      { stdio: "ignore", timeout: 5000 },
    );
  }
}

/** Extract a field value from `security` command output. */
function extractKeychainField(output: string, fieldName: string): string | null {
  // Format: "acct"<blob>="username"
  const re = new RegExp(`${fieldName.replace(/"/g, '"')}.*?="([^"]*)"`, "m");
  const match = output.match(re);
  return match?.[1] ?? null;
}

/** Extract the password from `security -g` output (printed to stderr). */
function extractKeychainPassword(output: string): string | null {
  // Format: password: "thepassword"
  const match = output.match(/password:\s*"([^"]*)"/);
  if (match) return match[1];

  // Format: password: 0x... (hex encoded)
  const hexMatch = output.match(/password:\s*0x([0-9A-Fa-f]+)/);
  if (hexMatch) return Buffer.from(hexMatch[1], "hex").toString("utf-8");

  return null;
}

// ── 1Password CLI Provider ───────────────────────────────────────────────────

export class OnePasswordProvider implements CredentialProvider {
  name = "1password";

  async isAvailable(): Promise<boolean> {
    try {
      execSync("op --version", { stdio: "ignore", timeout: 5000 });
      // Check if signed in
      execSync("op whoami", { stdio: "ignore", timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }

  async lookup(domain: string): Promise<LoginCredential[]> {
    const results: LoginCredential[] = [];

    try {
      // Search for login items matching the domain
      const itemsJson = execSync(
        `op item list --categories Login --format json 2>/dev/null`,
        { encoding: "utf-8", timeout: 15000 },
      );

      const items = JSON.parse(itemsJson) as Array<{
        id: string;
        title: string;
        urls?: Array<{ href: string; primary?: boolean }>;
      }>;

      // Filter items that match the domain
      const matchingItems = items.filter((item) => {
        if (!item.urls) return false;
        return item.urls.some((u) => {
          try {
            return new URL(u.href).hostname.includes(domain) ||
                   domain.includes(new URL(u.href).hostname);
          } catch {
            return u.href.includes(domain);
          }
        });
      });

      // Get full details for matching items (limit to 3 to avoid slowness)
      for (const item of matchingItems.slice(0, 3)) {
        try {
          const detailJson = execSync(
            `op item get "${shellEscape(item.id)}" --format json 2>/dev/null`,
            { encoding: "utf-8", timeout: 10000 },
          );

          const detail = JSON.parse(detailJson) as {
            id: string;
            title: string;
            fields?: Array<{
              id: string;
              type: string;
              purpose?: string;
              label?: string;
              value?: string;
            }>;
            urls?: Array<{ href: string; primary?: boolean }>;
          };

          const usernameField = detail.fields?.find(
            (f) => f.purpose === "USERNAME" || f.id === "username" || f.label?.toLowerCase() === "username" || f.label?.toLowerCase() === "email",
          );
          const passwordField = detail.fields?.find(
            (f) => f.purpose === "PASSWORD" || f.id === "password" || f.type === "CONCEALED",
          );

          if (usernameField?.value && passwordField?.value) {
            const primaryUrl = detail.urls?.find((u) => u.primary)?.href ?? detail.urls?.[0]?.href;

            results.push({
              username: usernameField.value,
              password: passwordField.value,
              url: primaryUrl,
              label: `1Password: ${detail.title}`,
              source: "1password",
            });
          }
        } catch {
          // Skip this item if we can't fetch details
        }
      }
    } catch {
      // 1Password CLI not available or not signed in
    }

    return results;
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

      // Look up by service name (domain-based)
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

      // Also try without TLD
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

/**
 * Create a credential provider based on config value.
 * Returns null for "none" or unrecognized values.
 *
 * "auto" mode tries providers in order: keychain → 1password → vault,
 * returning the first one whose CLI/backend is available on this system.
 * This is a synchronous factory — "auto" creates a lazy wrapper that
 * detects at first lookup time.
 */
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

/**
 * Auto-detect provider — lazily resolves to the first available provider.
 * Tries: keychain → 1password → vault.
 */
class AutoDetectProvider implements CredentialProvider {
  name = "auto";
  private resolved: CredentialProvider | null | undefined = undefined; // undefined = not yet checked
  private vaultDbPath?: string;

  constructor(vaultDbPath?: string) {
    this.vaultDbPath = vaultDbPath;
  }

  private async resolve(): Promise<CredentialProvider | null> {
    if (this.resolved !== undefined) return this.resolved;

    const candidates: CredentialProvider[] = [
      new KeychainProvider(),
      new OnePasswordProvider(),
    ];
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
        // Skip unavailable provider
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

/**
 * Look up credentials for a URL, extracting the domain automatically.
 * Returns the first matching credential, or null.
 */
export async function lookupCredentials(
  provider: CredentialProvider,
  url: string,
): Promise<LoginCredential | null> {
  try {
    const hostname = new URL(url).hostname;
    // Try the full hostname first
    let creds = await provider.lookup(hostname);
    if (creds.length > 0) return creds[0];

    // Try without www. prefix
    if (hostname.startsWith("www.")) {
      creds = await provider.lookup(hostname.slice(4));
      if (creds.length > 0) return creds[0];
    }

    // Try the base domain (e.g. "login.github.com" → "github.com")
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

// ── Common login form selectors ──────────────────────────────────────────────

/**
 * Build formFields from a credential by guessing common login form selectors.
 * The agent can override these with explicit selectors if needed.
 */
export function buildFormFields(cred: LoginCredential): Record<string, string> {
  // Common selector patterns for login forms
  // Priority: specific selectors first, then broader ones
  return {
    'input[type="email"], input[name="email"], input[name="username"], input[name="login"], input[id="email"], input[id="username"], input[id="login"], input[autocomplete="username"], input[autocomplete="email"]':
      cred.username,
    'input[type="password"], input[name="password"], input[id="password"], input[autocomplete="current-password"]':
      cred.password,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function shellEscape(s: string): string {
  return s.replace(/['"\\$`!]/g, "\\$&");
}
