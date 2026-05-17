import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import { bearerAuth } from "../middleware/auth.js";
import {
  pushCookies,
  pullCookies,
  listSyncedDomains,
  deleteSyncedDomain,
  purgeVault,
  VaultNotConfiguredError,
  type CookieRecord,
} from "../services/cookie-vault.js";

type CookieEnv = { Bindings: Env; Variables: { agent_id: string; user_id?: string } };

export const cookieRoutes = new Hono<CookieEnv>();

cookieRoutes.use("/account/cookies", bearerAuth);
cookieRoutes.use("/account/cookies/*", bearerAuth);

function accountRequired(c: Context<CookieEnv>) {
  return c.json({
    error: "account_required",
    message: "This endpoint requires an account-bound API key. Run `unbrowse register --email …`.",
  }, 403);
}

function vaultNotConfigured(c: Context<CookieEnv>) {
  return c.json({
    error: "vault_not_configured",
    message: "Cookie cloud sync is not configured on this deployment.",
  }, 503);
}

// GET /v1/account/cookies -- list synced domains for this account
cookieRoutes.get("/account/cookies", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  try {
    const domains = await listSyncedDomains(c.env, userId);
    return c.json({ domains });
  } catch (err) {
    if (err instanceof VaultNotConfiguredError) return vaultNotConfigured(c);
    throw err;
  }
});

// PUT /v1/account/cookies/:domain -- encrypt + store a domain's cookie set
cookieRoutes.put("/account/cookies/:domain", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  const domain = c.req.param("domain");
  if (!domain) return c.json({ error: "invalid_input", message: "domain required." }, 400);

  let body: { cookies?: unknown };
  try {
    body = JSON.parse(await c.req.text()) as { cookies?: unknown };
  } catch {
    return c.json({ error: "invalid_input", message: "Body must be valid JSON." }, 400);
  }
  if (!Array.isArray(body.cookies)) {
    return c.json({ error: "invalid_input", message: "cookies must be an array." }, 400);
  }
  for (const ck of body.cookies) {
    if (typeof ck !== "object" || ck === null || typeof (ck as CookieRecord).name !== "string") {
      return c.json({ error: "invalid_input", message: "each cookie needs a string name." }, 400);
    }
  }

  try {
    const row = await pushCookies(c.env, userId, domain, body.cookies as CookieRecord[]);
    return c.json({ ok: true, ...row });
  } catch (err) {
    if (err instanceof VaultNotConfiguredError) return vaultNotConfigured(c);
    if ((err as Error).message === "invalid_domain") {
      return c.json({ error: "invalid_input", message: "domain is empty after normalization." }, 400);
    }
    throw err;
  }
});

// GET /v1/account/cookies/:domain -- decrypt + return a domain's cookie set
cookieRoutes.get("/account/cookies/:domain", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  const domain = c.req.param("domain");
  if (!domain) return c.json({ error: "invalid_input", message: "domain required." }, 400);
  try {
    const cookies = await pullCookies(c.env, userId, domain);
    if (cookies === null) {
      return c.json({ error: "not_found", message: "No synced cookies for this domain." }, 404);
    }
    return c.json({ domain, cookies });
  } catch (err) {
    if (err instanceof VaultNotConfiguredError) return vaultNotConfigured(c);
    throw err;
  }
});

// DELETE /v1/account/cookies/:domain -- remove one domain (or ?all=1 to purge)
cookieRoutes.delete("/account/cookies/:domain", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  const domain = c.req.param("domain");
  if (!domain) return c.json({ error: "invalid_input", message: "domain required." }, 400);
  try {
    const removed = await deleteSyncedDomain(c.env, userId, domain);
    return c.json({ ok: true, domain, removed });
  } catch (err) {
    if (err instanceof VaultNotConfiguredError) return vaultNotConfigured(c);
    throw err;
  }
});

// DELETE /v1/account/cookies -- purge the entire vault for this account
cookieRoutes.delete("/account/cookies", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  try {
    const purged = await purgeVault(c.env, userId);
    return c.json({ ok: true, purged_domains: purged });
  } catch (err) {
    if (err instanceof VaultNotConfiguredError) return vaultNotConfigured(c);
    throw err;
  }
});
