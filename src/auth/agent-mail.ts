/**
 * Agent Mail — autonomous email-based login/registration primitive.
 *
 * Uses AgentMail (agentmail.to) to create disposable inboxes,
 * register on websites, and read verification emails/OTPs.
 *
 * Part of the auth DAG: when resolve detects auth_required and
 * the site supports email login, this primitive handles it autonomously.
 */

const AGENTMAIL_API = "https://api.agentmail.to";
const AGENTMAIL_KEY = process.env.AGENTMAIL_API_KEY ?? "";

interface AgentMailInbox {
  inbox_id: string;
  email: string;
}

interface AgentMailMessage {
  messageId: string;
  subject: string;
  from: string;
  text?: string;
  extractedText?: string;
  html?: string;
  extractedHtml?: string;
  receivedAt: string;
}

async function amFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${AGENTMAIL_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${AGENTMAIL_KEY}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AgentMail ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

/**
 * Get or create an inbox for a specific site.
 * Uses site domain as the username so each site gets its own inbox.
 * Idempotent via clientId.
 */
export async function getOrCreateSiteInbox(domain: string): Promise<AgentMailInbox> {
  const safeDomain = domain.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const username = `unbrowse-${safeDomain}`;
  const clientId = `unbrowse-login-${safeDomain}`;

  try {
    const inbox = (await amFetch("POST", "/inboxes", {
      username,
      domain: "agentmail.to",
      display_name: `Unbrowse Agent - ${domain}`,
      client_id: clientId,
    })) as AgentMailInbox;
    return inbox;
  } catch {
    // Already exists or limit — try to get existing
    const email = `${username}@agentmail.to`;
    try {
      const inbox = (await amFetch("GET", `/inboxes/${encodeURIComponent(email)}`)) as AgentMailInbox;
      return inbox;
    } catch {
      // Use the default unbrowse-agent inbox
      return { inbox_id: "unbrowse-agent@agentmail.to", email: "unbrowse-agent@agentmail.to" };
    }
  }
}

/**
 * Wait for a verification email to arrive.
 * Polls the inbox for up to `timeoutMs` looking for emails matching the domain.
 * Returns the email body text for OTP/link extraction.
 */
export async function waitForVerificationEmail(
  inboxId: string,
  fromDomain: string,
  timeoutMs = 60_000,
): Promise<{ subject: string; text: string; html: string } | null> {
  const start = Date.now();
  const pollInterval = 3_000;

  while (Date.now() - start < timeoutMs) {
    const data = (await amFetch("GET", `/inboxes/${encodeURIComponent(inboxId)}/messages?limit=5&labels=unread`)) as {
      messages: AgentMailMessage[];
    };

    for (const msg of data.messages ?? []) {
      // Match emails from the target domain
      if (msg.from?.toLowerCase().includes(fromDomain.toLowerCase())) {
        return {
          subject: msg.subject ?? "",
          text: msg.extractedText ?? msg.text ?? "",
          html: msg.extractedHtml ?? msg.html ?? "",
        };
      }
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  return null;
}

/**
 * Extract OTP code from email text.
 * Looks for common patterns: 6-digit codes, 4-digit codes, verification links.
 */
export function extractOtpFromEmail(text: string): string | null {
  // 6-digit code (most common)
  const six = text.match(/\b(\d{6})\b/);
  if (six) return six[1];

  // 4-digit code
  const four = text.match(/\b(\d{4})\b/);
  if (four) return four[1];

  // "code is: XXXX" or "code: XXXX"
  const codeIs = text.match(/code[:\s]+(\w{4,8})/i);
  if (codeIs) return codeIs[1];

  return null;
}

/**
 * Extract verification/magic link from email.
 */
export function extractVerificationLink(text: string, html: string): string | null {
  // Check HTML first — links are more reliable there
  const htmlLink = html.match(/href="(https?:\/\/[^"]*(?:verify|confirm|activate|magic|token|auth)[^"]*)"/i);
  if (htmlLink) return htmlLink[1];

  // Fall back to text
  const textLink = text.match(/(https?:\/\/\S*(?:verify|confirm|activate|magic|token|auth)\S*)/i);
  if (textLink) return textLink[1];

  // Any link in the email
  const anyLink = text.match(/(https?:\/\/\S+)/);
  if (anyLink) return anyLink[1];

  return null;
}

/**
 * Full autonomous email login flow:
 * 1. Create site-specific inbox
 * 2. Return email address for registration
 * 3. Wait for verification email
 * 4. Extract OTP or magic link
 */
export async function autonomousEmailLogin(domain: string): Promise<{
  email: string;
  inboxId: string;
  waitForOtp: () => Promise<string | null>;
  waitForLink: () => Promise<string | null>;
}> {
  const inbox = await getOrCreateSiteInbox(domain);

  return {
    email: inbox.email,
    inboxId: inbox.inbox_id,
    waitForOtp: async () => {
      const email = await waitForVerificationEmail(inbox.inbox_id, domain, 90_000);
      if (!email) return null;
      return extractOtpFromEmail(email.text);
    },
    waitForLink: async () => {
      const email = await waitForVerificationEmail(inbox.inbox_id, domain, 90_000);
      if (!email) return null;
      return extractVerificationLink(email.text, email.html);
    },
  };
}
