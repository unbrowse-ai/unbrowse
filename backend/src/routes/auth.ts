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

/**
 * `return_url` shows up as the href of the "Return to app" button on the
 * post-signin page. Without an allowlist a publisher could feed in
 * `javascript:fetch(...)` for XSS, or `https://attacker.com/steal-token` for
 * phishing from a trusted unbrowse domain. We accept https on a small list
 * of host suffixes plus localhost for dev.
 */
const RETURN_URL_HOST_ALLOWLIST = ["unbrowse.ai", "openclaw.dev"];
function sanitizeReturnUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (trimmed.length > 2048) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  // Only allow http on localhost loopbacks
  if (parsed.protocol === "http:") {
    if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "::1") {
      return null;
    }
    return parsed.toString();
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = RETURN_URL_HOST_ALLOWLIST.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  if (!allowed) return null;
  return parsed.toString();
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
  const safeReturnUrl = sanitizeReturnUrl(return_url ?? null);
  const record: MagicRecord = {
    email: normalizedEmail,
    return_url: safeReturnUrl,
    status: "pending",
  };
  try {
    await statsKV(c.env).put(`magic:${token}`, JSON.stringify(record), { expirationTtl: 600 });
  } catch (err) {
    console.error("magic-link storage failed", (err as Error).message);
    return c.json({
      error: "storage_unavailable",
      message: "Backend storage (EMERGENTDB_API_KEY) not configured — magic-link signup unavailable.",
    }, 503);
  }

  try {
    await sendMagicLink(c.env, { email: normalizedEmail, token, returnUrl: safeReturnUrl ?? undefined });
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

  // Funnel telemetry: registration touchpoint (Layer 5 of funnel-tracking
  // plan). Fire-and-forget POST to /v1/telemetry/events so the funnel sees
  // every email-start that successfully dispatched a magic link. Best-effort
  // only: a failed telemetry insert never blocks the auth response.
  try {
    const { recordFunnelEvent } = await import("../services/funnel.js");
    await recordFunnelEvent(c.env, {
      install_id: `auth-email-start-${token.slice(0, 12)}`,
      name: "registration",
      source: "auth",
      properties: { email_domain: normalizedEmail.split("@")[1] ?? null },
    });
  } catch (err) {
    console.warn("[auth/email/start] funnel-event emit failed:", err instanceof Error ? err.message : String(err));
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

  // The override path can be set by anyone clicking the magic link with a
  // crafted query string. Re-sanitize so a phishing target can't dress up
  // an attacker URL with a stolen token.
  const returnUrl = sanitizeReturnUrl(returnUrlOverride ?? stored.return_url ?? null);

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

// ---------------------------------------------------------------------------
// Privy auth (Wave 3 of wire-privy-authentication-end-to-end-for-unbrows).
//
// Flow: frontend signs the user in via @privy-io/react-auth (the
// PrivyOptionalProvider in frontend/src/lib/privy-provider.tsx), Privy
// auto-creates an embedded Solana wallet for users without one (Wave 1
// flipped this from ethereum), then the frontend posts the resulting
// Privy access token here. The route verifies the JWT, fetches the
// user's embedded Solana wallet via Privy's REST API, registers or
// looks up the corresponding unbrowse agent, binds the wallet to the
// agent (so x402 sponsor middleware in backend/src/middleware/sponsor.ts
// settles to the right pubkey), and returns the api_key + agent_id +
// wallet_address. Mirrors the shape of /v1/auth/email/poll so the
// frontend hook can swap implementations without restructuring callers.
// ---------------------------------------------------------------------------
authRoutes.post("/auth/privy/start", async (c) => {
  if (!c.env.PRIVY_APP_ID || !c.env.PRIVY_APP_SECRET) {
    return c.json(
      {
        error: "privy_not_configured",
        message:
          "Backend PRIVY_APP_ID/PRIVY_APP_SECRET not set. Configure via wrangler secret put PRIVY_APP_SECRET and PRIVY_APP_ID in wrangler.toml.",
      },
      503,
    );
  }
  let body: { privy_token?: string };
  try {
    body = (await c.req.json()) as { privy_token?: string };
  } catch {
    return c.json({ error: "invalid_json", message: "Request body must be JSON with a privy_token field" }, 400);
  }
  const token = (body.privy_token ?? "").trim();
  if (!token) {
    return c.json({ error: "privy_token_required", message: "POST body must include privy_token" }, 400);
  }

  const { verifyPrivyAndLoadWallet } = await import("../services/privy.js");
  let verified: { privy_user_id: string; embedded_solana_wallet: string | null };
  try {
    verified = await verifyPrivyAndLoadWallet(token, c.env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Privy errors carry stable prefixes (privy_jwt_expired, privy_jwt_signature_invalid,
    // privy_jwt_audience_mismatch, privy_user_fetch_failed:<status>, etc). Surface
    // them verbatim so the frontend can branch on the prefix.
    return c.json({ error: message.split(":")[0] || "privy_verification_failed", message }, 401);
  }

  // The privy_user_id is our stable identity. Look up an existing user
  // record bound to it (synthetic email shape "privy:<did>@unbrowse.local"
  // so it doesn't collide with real emails) or upsert one.
  const syntheticEmail = `privy-${verified.privy_user_id.replace(/[^a-zA-Z0-9_-]/g, "_")}@unbrowse.privy`;
  const user = await upsertUser(c.env, syntheticEmail);
  const userId = user.user_id;

  // Mint a fresh API key for this session. createLocalKey returns
  // { keyId, key, meta }; keyId IS the agent_id (32-char prefix), key
  // is the full bearer-shaped token the client sends as Authorization.
  const { keyId: agentId, key: apiKey } = await createLocalKey(c.env, syntheticEmail);

  // Ensure an agent profile exists for this id; bind the user.
  await ensureAgentProfile(c.env, agentId, { name: syntheticEmail });
  await bindKeyToUser(c.env, agentId, userId);


  // Wave 3 finale: bind the Privy embedded Solana wallet to the agent
  // record so x402 sponsor middleware can settle to it. If the user
  // signed in with an external (non-Privy) wallet on a non-Solana
  // chain, embedded_solana_wallet is null and we just leave the agent
  // without a wallet binding (the agent can attach one later via the
  // existing /v1/account/wallet flow).
  let walletBound: string | null = null;
  if (verified.embedded_solana_wallet) {
    try {
      const { updateAgentWallet } = await import("../services/agents.js");
      await updateAgentWallet(c.env, agentId, {
        wallet_address: verified.embedded_solana_wallet,
        wallet_provider: "privy_embedded_solana",
      });
      walletBound = verified.embedded_solana_wallet;
    } catch (err) {
      // Non-fatal: surface the binding error but still return the api_key
      // so the user can sign in and bind manually later.
      console.error("privy_wallet_bind_failed", agentId, (err as Error).message);
    }
  }

  return c.json({
    status: "verified",
    api_key: apiKey,
    agent_id: agentId,
    user_id: userId,
    privy_user_id: verified.privy_user_id,
    wallet_address: walletBound,
    wallet_provider: walletBound ? "privy_embedded_solana" : null,
  });
});
