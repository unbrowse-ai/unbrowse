/**
 * Email provider abstraction — the interface agents interact with.
 *
 * Three providers, tried in order:
 *   1. Gmail (via GWS) — real account, use for sites you already have accounts on
 *   2. AgentMail — disposable inbox, use for registration / new accounts
 *   3. IMAP/SMTP (via himalaya) — custom email provider
 *
 * Setup configures which providers are available.
 * The auth runtime picks the best one for each situation.
 */

import { log } from "../logger.js";

export interface EmailMessage {
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  receivedAt: Date;
}

export interface EmailProvider {
  readonly name: string;
  readonly configured: boolean;

  /** Get or create an inbox/address for a domain. */
  getAddress(domain: string): Promise<string>;

  /** Send an email. */
  send(to: string, subject: string, body: string): Promise<{ messageId: string }>;

  /** Poll for a message from a specific domain. */
  waitForMessage(fromDomain: string, timeoutMs?: number): Promise<EmailMessage | null>;
}

// ── AgentMail provider ─────────────────────────────────────────────

class AgentMailProvider implements EmailProvider {
  readonly name = "agentmail";
  get configured() { return Boolean(process.env.AGENTMAIL_API_KEY); }

  async getAddress(domain: string): Promise<string> {
    const { getOrCreateSiteInbox } = await import("./agent-mail.js");
    const inbox = await getOrCreateSiteInbox(domain);
    return inbox.email;
  }

  async send(to: string, subject: string, body: string): Promise<{ messageId: string }> {
    const { autonomousEmailLogin } = await import("./agent-mail.js");
    const session = await autonomousEmailLogin("general");
    const result = await session.sendEmail(to, subject, body);
    return { messageId: result.messageId };
  }

  async waitForMessage(fromDomain: string, timeoutMs = 90_000): Promise<EmailMessage | null> {
    const { autonomousEmailLogin, waitForVerificationEmail } = await import("./agent-mail.js");
    const session = await autonomousEmailLogin(fromDomain);
    const email = await waitForVerificationEmail(session.inboxId, fromDomain, timeoutMs);
    return email;
  }
}

// ── Gmail provider (via GWS) ───────────────────────────────────────

class GmailProvider implements EmailProvider {
  readonly name = "gmail";
  get configured() {
    // Gmail is configured if the gws-gmail skill is available
    // Check for gcloud auth or gmail credentials
    try {
      const { existsSync } = require("fs");
      const { homedir } = require("os");
      const { join } = require("path");
      return existsSync(join(homedir(), ".config", "gcloud", "application_default_credentials.json"));
    } catch {
      return false;
    }
  }

  async getAddress(_domain: string): Promise<string> {
    // Gmail address is the user's own email — fetch from gcloud config
    const { execSync } = require("child_process");
    try {
      const email = execSync("gcloud config get-value account 2>/dev/null", { encoding: "utf-8" }).trim();
      if (email && email.includes("@")) return email;
    } catch { /* not available */ }
    throw new Error("Gmail not configured — run: gcloud auth login");
  }

  async send(_to: string, _subject: string, _body: string): Promise<{ messageId: string }> {
    // Delegates to gws-gmail-send skill via CLI
    // This is a stub — actual implementation would call the GWS API
    throw new Error("Gmail send not yet wired — use AgentMail or the gws-gmail-send skill directly");
  }

  async waitForMessage(_fromDomain: string, _timeoutMs = 90_000): Promise<EmailMessage | null> {
    // Delegates to gws-gmail skill for inbox polling
    throw new Error("Gmail inbox polling not yet wired — use AgentMail or the gws-gmail skill directly");
  }
}

// ── Provider router ────────────────────────────────────────────────

const providers: EmailProvider[] = [
  new GmailProvider(),
  new AgentMailProvider(),
];

/**
 * Get the best available email provider.
 *
 * For login on existing accounts: prefers Gmail (real identity)
 * For registration on new sites: prefers AgentMail (disposable)
 */
export function getEmailProvider(purpose: "login" | "register" | "general" = "general"): EmailProvider | null {
  if (purpose === "register") {
    // For registration, prefer disposable inbox
    const agentmail = providers.find((p) => p.name === "agentmail" && p.configured);
    if (agentmail) return agentmail;
  }

  if (purpose === "login") {
    // For login, prefer real account
    const gmail = providers.find((p) => p.name === "gmail" && p.configured);
    if (gmail) return gmail;
  }

  // Fall back to whatever is configured
  return providers.find((p) => p.configured) ?? null;
}

/**
 * Get all configured email providers.
 */
export function getConfiguredProviders(): EmailProvider[] {
  return providers.filter((p) => p.configured);
}

/**
 * Check if any email provider is available.
 */
export function hasEmailProvider(): boolean {
  return providers.some((p) => p.configured);
}
