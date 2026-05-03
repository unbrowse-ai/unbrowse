import { Hono } from "hono";
import type { Env } from "../types.js";
import { statsKV } from "../services/kv.js";
import { sendMagicLink, EmailNotConfiguredError } from "../services/email.js";
import { upsertUser, bindKeyToUser } from "../services/accounts.js";
import { createLocalKey } from "../services/keys.js";
import { ensureAgentProfile } from "../services/agents.js";

export const authRoutes = new Hono<{ Bindings: Env }>();

interface MagicRecord {
  email: string;
  return_url: string | null;
  status: "pending" | "verified";
  api_key?: string;
  agent_id?: string;
  user_id?: string;
}

function isEmailShaped(email: string): boolean {
  const trimmed = email.trim();
  if (!trimmed) return false;
  // RFC 5321 caps the address path at 254 chars. Anything beyond is either an
  // attack (DoS via giant input) or a typo — reject before doing any work.
  if (trimmed.length > 254) return false;
  // Reject any control character (CR/LF/NUL/etc.) in the address. Header
  // injection (`a@b.com\r\nBcc: attacker@evil.com`) and SMTP smuggling rely on
  // these; a real email never contains them.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return false;
  const at = trimmed.indexOf("@");
  if (at < 1 || at !== trimmed.lastIndexOf("@")) return false;
  const domain = trimmed.slice(at + 1);
  return domain.includes(".") && domain.length >= 3;
}

function genToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// POST /v1/auth/email/start
authRoutes.post("/auth/email/start", async (c) => {
  const { email, return_url } = await c.req.json<{ email?: string; return_url?: string }>();
  if (!email || !isEmailShaped(email)) {
    return c.json({ error: "invalid_email" }, 400);
  }
  if (!c.env.RESEND_API_KEY) {
    return c.json({
      error: "email_not_configured",
      message: "Backend RESEND_API_KEY missing — magic-link signup unavailable.",
    }, 503);
  }

  const token = genToken();
  const normalizedEmail = email.trim().toLowerCase();
  const record: MagicRecord = {
    email: normalizedEmail,
    return_url: return_url ?? null,
    status: "pending",
  };
  try {
    await statsKV(c.env).put(`magic:${token}`, JSON.stringify(record), { expirationTtl: 600 });
  } catch (err) {
    console.error("magic-link storage failed", (err as Error).message);
    return c.json({
      error: "storage_unavailable",
      message: "Backend storage (EMERGENTDB_API_KEY or DATABASE_URL) not configured — magic-link signup unavailable.",
    }, 503);
  }

  try {
    await sendMagicLink(c.env, { email: normalizedEmail, token, returnUrl: return_url });
  } catch (err) {
    // Clean up the pending magic: row so a failed send never leaves a
    // dangling token that could be polled or look "active" in audits.
    try { await statsKV(c.env).delete(`magic:${token}`); } catch { /* best-effort */ }
    if (err instanceof EmailNotConfiguredError) {
      return c.json({
        error: "email_not_configured",
        message: "Backend RESEND_API_KEY missing — magic-link signup unavailable.",
      }, 503);
    }
    const message = (err as Error).message;
    console.error("magic-link send failed", message);
    return c.json({ error: "email_send_failed", message }, 502);
  }

  return c.json({ token, expires_in: 600 });
});

// GET /v1/auth/email/verify?token=&return_url=
authRoutes.get("/auth/email/verify", async (c) => {
  const token = c.req.query("token") ?? "";
  const returnUrlOverride = c.req.query("return_url");
  const kv = statsKV(c.env);
  const raw = await kv.get(`magic:${token}`);
  if (!raw) {
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(
      "<p>This sign-in link has expired. Run <code>unbrowse register --email …</code> again.</p>",
      410,
    );
  }

  let stored: MagicRecord;
  try {
    stored = JSON.parse(raw as string) as MagicRecord;
  } catch {
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(
      "<p>This sign-in link has expired. Run <code>unbrowse register --email …</code> again.</p>",
      410,
    );
  }

  const returnUrl = returnUrlOverride ?? stored.return_url ?? null;

  if (stored.status !== "verified") {
    const user = await upsertUser(c.env, stored.email, { verifyNow: true });
    const { keyId, key } = await createLocalKey(c.env, stored.email);
    await bindKeyToUser(c.env, keyId, user.user_id);
    await ensureAgentProfile(c.env, keyId, { name: stored.email });

    const updated: MagicRecord = {
      ...stored,
      status: "verified",
      api_key: key,
      agent_id: keyId,
      user_id: user.user_id,
    };
    await kv.put(`magic:${token}`, JSON.stringify(updated), { expirationTtl: 60 });
  }

  // Content negotiation: a real browser tab (the user clicking the magic link
  // in their inbox) sends `Accept: text/html` and lands here. Send those users
  // to the frontend /login page with the token so the SPA can consume it via
  // /v1/auth/email/poll, store the api_key, and route into /dashboard. CLI and
  // programmatic callers (no Accept: text/html, or explicit ?cli=1) keep the
  // backward-compatible 200 HTML page that the tests assert on.
  const accept = c.req.header("Accept") ?? c.req.header("accept") ?? "";
  const cliMode = c.req.query("cli") === "1";
  const isBrowserTab = !cliMode && accept.toLowerCase().includes("text/html");
  if (isBrowserTab) {
    const frontend = (c.env.PUBLIC_FRONTEND_URL ?? "https://www.unbrowse.ai").replace(/\/+$/, "");
    const location = `${frontend}/login?token=${encodeURIComponent(token)}&signed_in=1`;
    return c.redirect(location, 302);
  }

  c.header("Content-Type", "text/html; charset=utf-8");
  const returnButton = returnUrl
    ? `<p><a href="${escapeHtml(returnUrl)}" style="display:inline-block;padding:8px 16px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:4px">Return to app</a></p>`
    : "";
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;line-height:1.5">` +
      `<h2>Signed in</h2>` +
      `<p>You can close this tab and return to your terminal.</p>` +
      returnButton +
      `</body></html>`,
  );
});

// GET /v1/auth/email/poll?token=
authRoutes.get("/auth/email/poll", async (c) => {
  const token = c.req.query("token") ?? "";
  const kv = statsKV(c.env);
  const raw = await kv.get(`magic:${token}`);
  if (!raw) {
    return c.json({ status: "expired" }, 410);
  }
  let stored: MagicRecord;
  try {
    stored = JSON.parse(raw as string) as MagicRecord;
  } catch {
    return c.json({ status: "expired" }, 410);
  }

  if (stored.status === "pending") {
    return c.json({ status: "pending" });
  }

  // Verified: one-shot consume
  await kv.delete(`magic:${token}`);
  const fallbackAgentId = stored.api_key?.startsWith("ubr_")
    ? stored.api_key.slice("ubr_".length, "ubr_".length + 32)
    : undefined;
  return c.json({
    status: "verified",
    api_key: stored.api_key,
    agent_id: stored.agent_id ?? fallbackAgentId,
    user_id: stored.user_id,
    email: stored.email,
  });
});
