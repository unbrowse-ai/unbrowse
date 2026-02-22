import type { Context, Next } from "hono";
import type { Env } from "../types.js";

type AuthEnv = { Bindings: Env; Variables: { agent_id: string } };

async function verifyUnkey(rootKey: string, key: string): Promise<{ valid: boolean; keyId?: string; code?: string }> {
  const res = await fetch("https://api.unkey.com/v2/keys.verifyKey", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${rootKey}`,
    },
    body: JSON.stringify({ key }),
  });
  const json = await res.json() as { data?: { valid: boolean; keyId?: string; code?: string } };
  return json.data ?? { valid: false, code: "FETCH_ERROR" };
}

export async function bearerAuth(c: Context<AuthEnv>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.slice(7);

  // Legacy admin key (backward compat for existing CLI installs)
  if (token === c.env.API_KEY) {
    c.set("agent_id", "__admin__");
    await next();
    return;
  }

  // Verify via Unkey v2 REST API
  const result = await verifyUnkey(c.env.UNKEY_ROOT_KEY, token);

  if (!result.valid) {
    return c.json({ error: "Invalid API key", code: result.code }, 403);
  }

  c.set("agent_id", result.keyId!);
  await next();
}

/** Optional auth — sets agent_id if a valid key is present, but never rejects. */
export async function optionalAuth(c: Context<AuthEnv>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token === c.env.API_KEY) {
      c.set("agent_id", "__admin__");
    } else {
      const result = await verifyUnkey(c.env.UNKEY_ROOT_KEY, token);
      if (result.valid) {
        c.set("agent_id", result.keyId!);
      }
    }
  }
  await next();
}
