import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import { bearerAuth } from "../middleware/auth.js";
import { getUserById, listKeysForUser, getAccountPreferences, setAccountPreferences } from "../services/accounts.js";
import { listSkills } from "../services/marketplace.js";

type AccountEnv = { Bindings: Env; Variables: { agent_id: string; user_id?: string } };

export const accountRoutes = new Hono<AccountEnv>();

accountRoutes.use("/account/*", bearerAuth);

function accountRequired(c: Context<AccountEnv>) {
  return c.json({
    error: "account_required",
    message: "This endpoint requires an account-bound API key. Run `unbrowse register --email …`.",
  }, 403);
}

// GET /v1/account/me
accountRoutes.get("/account/me", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);

  const user = await getUserById(c.env, userId);
  if (!user) return c.json({ error: "user_not_found" }, 500);

  const keys = await listKeysForUser(c.env, userId);
  // TODO(slice-2): owner_user_id on skills — until then count is 0
  const skillsCount = (await listSkills(c.env)).filter((s) => (s as { owner_user_id?: string }).owner_user_id === userId).length;

  return c.json({
    user_id: user.user_id,
    email: user.email,
    created_at: user.created_at,
    verified_at: user.verified_at ?? null,
    keys_count: keys.length,
    skills_count: skillsCount,
  });
});

// GET /v1/account/keys
accountRoutes.get("/account/keys", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);

  const keyIds = await listKeysForUser(c.env, userId);
  // TODO(account-meta): plumb created_at via inverse index
  return c.json({ keys: keyIds.map((id) => ({ keyId: id })) });
});

// GET /v1/account/skills
accountRoutes.get("/account/skills", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);

  // TODO(slice-2): owner_user_id on skills — returns [] until then
  const skills = (await listSkills(c.env)).filter((s) => (s as { owner_user_id?: string }).owner_user_id === userId);
  return c.json({ skills });
});

// GET /v1/account/preferences
accountRoutes.get("/account/preferences", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  const prefs = await getAccountPreferences(c.env, userId);
  return c.json(prefs);
});

// PATCH /v1/account/preferences
accountRoutes.patch("/account/preferences", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);

  let body: Record<string, unknown> = {};
  try {
    const text = await c.req.text();
    if (text.trim().length > 0) body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_input", message: "Body must be valid JSON." }, 400);
  }

  if ("share_pointers" in body && typeof body.share_pointers !== "boolean") {
    return c.json({ error: "invalid_input", message: "share_pointers must be a boolean." }, 400);
  }

  const patch: Partial<{ share_pointers: boolean }> = {};
  if (typeof body.share_pointers === "boolean") patch.share_pointers = body.share_pointers;

  const prefs = await setAccountPreferences(c.env, userId, patch);
  return c.json(prefs);
});
