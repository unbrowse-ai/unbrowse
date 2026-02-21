import { Hono } from "hono";
import type { Env } from "./types.js";
import { bearerAuth } from "./middleware/auth.js";
import { skillRoutes } from "./routes/skills.js";
import { searchRoutes } from "./routes/search.js";
import { statsRoutes } from "./routes/stats.js";
import { healthRoutes } from "./routes/health.js";

const app = new Hono<{ Bindings: Env }>();

// Public routes
app.route("/", healthRoutes);

// Protected routes
const api = new Hono<{ Bindings: Env }>();
api.use("*", bearerAuth);
api.route("/v1", skillRoutes);
api.route("/v1", searchRoutes);
api.route("/v1", statsRoutes);
app.route("/", api);

export default app;
