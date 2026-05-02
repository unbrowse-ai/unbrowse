import { Hono } from "hono";
import type { Env } from "../types.js";
import { bearerAuth } from "../middleware/auth.js";
import { getUserById, listKeysForUser } from "../services/accounts.js";
import { listSkills } from "../services/marketplace.js";

type AccountEnv = { Bindings: Env; Variables: { agent_id: string; user_id?: string } };

export const accountRoutes = new Hono<AccountEnv>();

accountRoutes.use("/account/*", bearerAuth);

function accountRequired(c: Parameters<Parameters<typeof accountRoutes.get>[1]>[0]) {
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
