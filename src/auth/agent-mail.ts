/**
 * Agent Mail — autonomous email-based login/registration primitive.
 *
 * Uses the AgentMail SDK (agentmail.to) to create disposable inboxes,
 * register on websites, read verification emails, and extract OTPs/magic links.
 *
 * Part of the auth DAG: when resolve detects auth_required and
 * the site supports email login, this primitive handles it autonomously.
 */

import { AgentMailClient } from "agentmail";
import { log } from "../logger.js";
import { storeCredential, getCredential } from "../vault/index.js";
import { getRegistrableDomain } from "../domain.js";

const POLL_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 90_000;

// Singleton client — lazy-initialized on first use
let _client: AgentMailClient | null = null;

function getClient(): AgentMailClient {
  if (_client) return _client;
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) throw new Error("AGENTMAIL_API_KEY not set — cannot use agent mail");
  _client = new AgentMailClient({ apiKey });
  return _client;
}

// ── Vault persistence ──────────────────────────────────────────────

const VAULT_PREFIX = "agentmail:";

interface StoredInbox {
  inboxId: string;
  email: string;
  domain: string;
  createdAt: string;
}

async function getStoredInbox(domain: string): Promise<StoredInbox | null> {
  const key = `${VAULT_PREFIX}${getRegistrableDomain(domain)}`;
  const raw = await getCredential(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredInbox;
  } catch {
    return null;
  }
}

async function storeInbox(domain: string, inbox: StoredInbox): Promise<void> {
  const key = `${VAULT_PREFIX}${getRegistrableDomain(domain)}`;
  await storeCredential(key, JSON.stringify(inbox));
  log("agent-mail", `stored inbox ${inbox.email} for ${domain}`);
}

// ── Inbox management ───────────────────────────────────────────────

/**
 * Get or create an inbox for a specific site.
 * Uses site domain as the username so each site gets its own inbox.
 * Idempotent via clientId — calling twice for the same domain returns the same inbox.
 */
export async function getOrCreateSiteInbox(domain: string): Promise<{
  inboxId: string;
  email: string;
}> {
  // Check vault first
  const stored = await getStoredInbox(domain);
  if (stored) {
    log("agent-mail", `reusing stored inbox ${stored.email} for ${domain}`);
    return { inboxId: stored.inboxId, email: stored.email };
  }

  const client = getClient();
  const safeDomain = getRegistrableDomain(domain).replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const username = `unbrowse-${safeDomain}`;
  const clientId = `unbrowse-login-${safeDomain}`;

  try {
    const inbox = await client.inboxes.create({
      username,
      domain: "agentmail.to",
      displayName: `Unbrowse Agent - ${domain}`,
      clientId,
    });

    const result = { inboxId: inbox.inboxId, email: inbox.email };
    await storeInbox(domain, { ...result, domain, createdAt: new Date().toISOString() });
    log("agent-mail", `created inbox ${inbox.email} for ${domain}`);
    return result;
  } catch (err: unknown) {
    // clientId collision = inbox already exists, try to find it
    log("agent-mail", `create failed (likely exists), listing to find match: ${err instanceof Error ? err.message : err}`);
    try {
      const list = await client.inboxes.list({ limit: 100 });
      const match = list.inboxes.find(
        (i) => i.clientId === clientId || i.email === `${username}@agentmail.to`,
      );
      if (match) {
        const result = { inboxId: match.inboxId, email: match.email };
        await storeInbox(domain, { ...result, domain, createdAt: new Date().toISOString() });
        return result;
      }
    } catch { /* list failed too */ }

    throw new Error(`Failed to create or find AgentMail inbox for ${domain}`);
  }
}

// ── Message polling ────────────────────────────────────────────────

export interface VerificationEmail {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  text: string;
  html: string;
  receivedAt: Date;
}

/**
 * Wait for a verification email to arrive from a specific domain.
 * Polls the inbox looking for emails where `from` matches the target domain.
 */
export async function waitForVerificationEmail(
  inboxId: string,
  fromDomain: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<VerificationEmail | null> {
  const client = getClient();
  const start = Date.now();
  const normalizedDomain = fromDomain.toLowerCase();

  log("agent-mail", `polling inbox ${inboxId} for email from *@${normalizedDomain} (timeout: ${timeoutMs}ms)`);

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await client.inboxes.messages.list(inboxId, {
        limit: 10,
        labels: ["received"],
      });

      for (const item of response.messages ?? []) {
        // Fetch full message to get body
        const msg = await client.inboxes.messages.get(inboxId, item.messageId);
        const from = typeof msg.from === "string" ? msg.from : (msg.from as string[] ?? []).join(", ");

        if (from.toLowerCase().includes(normalizedDomain)) {
          log("agent-mail", `found verification email from ${from}: "${msg.subject}"`);
          return {
            messageId: msg.messageId,
            threadId: msg.threadId,
            subject: msg.subject ?? "",
            from,
            text: msg.extractedText ?? msg.text ?? "",
            html: msg.extractedHtml ?? msg.html ?? "",
            receivedAt: msg.createdAt,
          };
        }
      }
    } catch (err) {
      log("agent-mail", `poll error: ${err instanceof Error ? err.message : err}`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  log("agent-mail", `timeout waiting for email from ${normalizedDomain}`);
  return null;
}

// ── OTP / magic link extraction ────────────────────────────────────

/**
 * Extract OTP code from email text.
 * Handles: 6-digit, 4-digit, alphanumeric codes, "code is: X" patterns.
 */
export function extractOtpFromEmail(text: string): string | null {
  // "your code is 123456" / "verification code: 123456"
  const codePhrase = text.match(/(?:verification|confirm|security|login|one[- ]time|otp)\s*(?:code|pin|number)[:\s]+(\w{4,8})/i);
  if (codePhrase) return codePhrase[1];

  // "code is: XXXX" / "code: XXXX" / "OTP: XXXX"
  const codeIs = text.match(/(?:code|otp|pin)[:\s]+(\w{4,8})/i);
  if (codeIs) return codeIs[1];

  // Standalone 6-digit code (most common OTP format)
  const six = text.match(/\b(\d{6})\b/);
  if (six) return six[1];

  // 4-digit code
  const four = text.match(/\b(\d{4})\b/);
  if (four) return four[1];

  return null;
}

/**
 * Extract verification/magic link from email content.
 * Checks HTML href attributes first (more reliable), then plain text.
 */
export function extractVerificationLink(text: string, html: string): string | null {
  // HTML links with verification-related paths
  const htmlLink = html.match(
    /href="(https?:\/\/[^"]*(?:verify|confirm|activate|magic|token|auth|callback|validate|approve|email)[^"]*)"/i,
  );
  if (htmlLink) return htmlLink[1];

  // Plain text links with verification-related paths
  const textLink = text.match(
    /(https?:\/\/\S*(?:verify|confirm|activate|magic|token|auth|callback|validate|approve|email)\S*)/i,
  );
  if (textLink) return textLink[1];

  // Any link as last resort (common in simple verification emails)
  const anyHtmlLink = html.match(/href="(https?:\/\/[^"]+)"/);
  if (anyHtmlLink) return anyHtmlLink[1];

  const anyTextLink = text.match(/(https?:\/\/\S+)/);
  if (anyTextLink) return anyTextLink[1];

  return null;
}

// ── Autonomous login flow ──────────────────────────────────────────

export interface AgentMailSession {
  email: string;
  inboxId: string;
  domain: string;
  /** Poll inbox for an OTP code from the target domain. */
  waitForOtp: (timeoutMs?: number) => Promise<string | null>;
  /** Poll inbox for a verification/magic link from the target domain. */
  waitForLink: (timeoutMs?: number) => Promise<string | null>;
  /** Poll inbox for the raw verification email. */
  waitForEmail: (timeoutMs?: number) => Promise<VerificationEmail | null>;
  /** Send an email from this inbox (e.g. for sites that require email-based registration). */
  sendEmail: (to: string, subject: string, body: string) => Promise<{ messageId: string; threadId: string }>;
  /** Reply to a specific message in the inbox. */
  replyTo: (messageId: string, body: string) => Promise<{ messageId: string; threadId: string }>;
}

/**
 * Full autonomous email login flow:
 * 1. Create site-specific inbox (idempotent)
 * 2. Return session with email address + helpers
 * 3. Caller uses the email to register/login on the site
 * 4. Session helpers poll for OTP or magic link
 *
 * Usage:
 * ```ts
 * const session = await autonomousEmailLogin("example.com");
 * // Use session.email to fill in the login form
 * await kuri.fill(tabId, "input[type=email]", session.email);
 * await kuri.click(tabId, "button[type=submit]");
 * // Wait for OTP
 * const otp = await session.waitForOtp();
 * ```
 */
export async function autonomousEmailLogin(domain: string): Promise<AgentMailSession> {
  const inbox = await getOrCreateSiteInbox(domain);
  const client = getClient();

  log("agent-mail", `session ready for ${domain} — email: ${inbox.email}`);

  return {
    email: inbox.email,
    inboxId: inbox.inboxId,
    domain,

    waitForOtp: async (timeoutMs = DEFAULT_TIMEOUT_MS) => {
      const email = await waitForVerificationEmail(inbox.inboxId, domain, timeoutMs);
      if (!email) return null;
      const otp = extractOtpFromEmail(email.text);
      if (otp) log("agent-mail", `extracted OTP: ${otp} from ${email.subject}`);
      return otp;
    },

    waitForLink: async (timeoutMs = DEFAULT_TIMEOUT_MS) => {
      const email = await waitForVerificationEmail(inbox.inboxId, domain, timeoutMs);
      if (!email) return null;
      const link = extractVerificationLink(email.text, email.html);
      if (link) log("agent-mail", `extracted verification link from ${email.subject}`);
      return link;
    },

    waitForEmail: (timeoutMs = DEFAULT_TIMEOUT_MS) =>
      waitForVerificationEmail(inbox.inboxId, domain, timeoutMs),

    sendEmail: async (to: string, subject: string, body: string) => {
      const result = await client.inboxes.messages.send(inbox.inboxId, {
        to: [to],
        subject,
        text: body,
      });
      log("agent-mail", `sent email to ${to}: "${subject}" (${result.messageId})`);
      return { messageId: result.messageId, threadId: result.threadId };
    },

    replyTo: async (messageId: string, body: string) => {
      const result = await client.inboxes.messages.reply(inbox.inboxId, messageId, {
        text: body,
      });
      log("agent-mail", `replied to ${messageId} (${result.messageId})`);
      return { messageId: result.messageId, threadId: result.threadId };
    },
  };
}

// ── Auth DAG integration ───────────────────────────────────────────

/**
 * Check if AgentMail is available (API key configured).
 */
export function isAgentMailAvailable(): boolean {
  return Boolean(process.env.AGENTMAIL_API_KEY);
}

/**
 * Attempt autonomous email-based auth for a domain.
 * Called by the auth DAG when interactive login detects an email input field.
 *
 * Returns the session if successful, or null if AgentMail is not available.
 */
export async function tryAgentMailAuth(domain: string): Promise<AgentMailSession | null> {
  if (!isAgentMailAvailable()) {
    log("agent-mail", `skipping — AGENTMAIL_API_KEY not set`);
    return null;
  }

  try {
    return await autonomousEmailLogin(domain);
  } catch (err) {
    log("agent-mail", `auth failed for ${domain}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
