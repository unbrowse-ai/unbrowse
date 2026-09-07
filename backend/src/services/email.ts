import type { Env } from "../types.js";

export interface SendMagicLinkInput {
  email: string;
  token: string;
  returnUrl?: string;
}

export class EmailNotConfiguredError extends Error {
  constructor() { super("RESEND_API_KEY not configured"); this.name = "EmailNotConfiguredError"; }
}

export async function sendMagicLink(env: Env, input: SendMagicLinkInput): Promise<void> {
  if (!env.RESEND_API_KEY) throw new EmailNotConfiguredError();
  const from = env.RESEND_FROM ?? "Unbrowse <auth@unbrowse.ai>";
  const base = env.PUBLIC_API_URL ?? "https://beta-api.unbrowse.ai";
  const ret = input.returnUrl ? `&return_url=${encodeURIComponent(input.returnUrl)}` : "";
  const verifyUrl = `${base}/v1/auth/email/verify?token=${input.token}${ret}`;

  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:520px;margin:32px auto;color:#1a1a1a">
<h2 style="margin:0 0 16px">Sign in to Unbrowse</h2>
<p>Click the link below to finish signing in. It expires in 10 minutes.</p>
<p style="margin:24px 0"><a href="${verifyUrl}" style="display:inline-block;padding:12px 20px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:6px">Click to sign in</a></p>
<p style="font-size:12px;color:#666;word-break:break-all">If the button does not work, paste this URL into your browser:<br>${verifyUrl}</p>
</body></html>`;

  const text = `Sign in to Unbrowse\n\nClick the link below to finish signing in. It expires in 10 minutes.\n\n${verifyUrl}\n`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [input.email], subject: "Sign in to Unbrowse", html, text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`resend ${res.status}: ${body.slice(0, 300)}`);
  }
}
