import { Hono } from "hono";
import type { Env } from "../types.js";
import { processGithubWebhook, verifyGithubWebhookSignature } from "../services/github-webhooks.js";

export const webhookRoutes = new Hono<{ Bindings: Env }>();

webhookRoutes.post("/webhooks/github", async (c) => {
  if (!c.env.GITHUB_WEBHOOK_SECRET?.trim()) {
    return c.json({ error: "GITHUB_WEBHOOK_SECRET not configured" }, 500);
  }

  const payloadText = await c.req.text();
  const signature = c.req.header("X-Hub-Signature-256");
  const eventName = c.req.header("X-GitHub-Event");
  const deliveryId = c.req.header("X-GitHub-Delivery");

  if (!eventName || !deliveryId) {
    return c.json({ error: "Missing GitHub webhook headers" }, 400);
  }

  const valid = await verifyGithubWebhookSignature(c.env.GITHUB_WEBHOOK_SECRET, payloadText, signature);
  if (!valid) {
    return c.json({ error: "Invalid webhook signature" }, 401);
  }

  const result = await processGithubWebhook(c.env, eventName, deliveryId, payloadText);
  c.status(result.status as 200 | 202 | 400 | 500);
  return c.json(result);
});
