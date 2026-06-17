// POST /v1/solve — the server-side PAID captcha-solve tier. Mirrors /v1/proxy:
// the secret (the Capzy key) lives ONLY here on the backend (the moat), and a
// solve is metered to the agent's key — never returned to or held by the client.
// The client (src/execution/captcha-clear.ts) escalates a render block here,
// gets a token, and injects it locally.
//
// Auth: Bearer api key (agent_id via optionalAuth) OR x402 payment proof — else
// 402 with payment requirements, exactly like /v1/proxy. Honest degrade: 503 if
// the server has no Capzy key, 502 on solve failure — never a fabricated token.
import { Hono } from "hono";
import type { Env } from "../types.js";
import { optionalAuth } from "../middleware/auth.js";
import { recordProxySurcharge } from "../middleware/sponsor.js";

// Vendor → live Capzy task type (kept in lockstep with the client's
// capzyTaskTypeForVendor in src/execution/captcha-solve.ts).
const CAPZY_TASK_TYPE: Readonly<Record<string, string>> = {
  cloudflare: "AntiTurnstileTaskProxyLess",
  recaptcha: "ReCaptchaV2TaskProxyLess",
  funcaptcha: "FunCaptchaTaskProxyLess",
  arkoselabs: "FunCaptchaTaskProxyLess",
  geetest: "GeeTestTaskProxyLess",
  akamai_bot_manager: "AntiAkamaiBMPTaskProxyLess",
  kasada: "KasadaCaptchaTaskProxyLess",
  mtcaptcha: "MtCaptchaTaskProxyLess",
  yidun: "YidunSliderTaskProxyLess",
  captchafox: "CaptchaFoxTaskProxyLess",
  friendlycaptcha: "FriendlyCaptchaTaskProxyLess",
};

const SITEKEY_RE = /data-sitekey=["']([^"']+)["']/i;

interface SolveRequestBody {
  vendor?: string;
  body?: string;
  url?: string;
}

async function solveViaCapzy(
  env: Env,
  taskType: string,
  websiteURL: string,
  websiteKey: string,
  timeoutMs: number,
): Promise<{ token: string } | { error: string }> {
  const apiBase = (env.CAPZY_URL?.trim() || "https://api.capzy.ai").replace(/\/+$/, "");
  const clientKey = env.CAPZY_KEY?.trim();
  if (!clientKey) return { error: "solver_unconfigured" };
  const deadline = Date.now() + timeoutMs;

  let taskId: string;
  try {
    const created = await fetch(`${apiBase}/createTask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientKey, task: { type: taskType, websiteURL, websiteKey } }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - Date.now()))),
    });
    const cj = (await created.json().catch(() => null)) as { taskId?: string; errorId?: number } | null;
    if (!cj || cj.errorId || !cj.taskId) return { error: "create_failed" };
    taskId = cj.taskId;
  } catch {
    return { error: "create_error" };
  }

  // Poll getTaskResult until ready or deadline.
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const polled = await fetch(`${apiBase}/getTaskResult`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKey, taskId }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))),
      });
      const rj = (await polled.json().catch(() => null)) as
        | { status?: string; errorId?: number; solution?: Record<string, unknown> }
        | null;
      if (!rj || rj.errorId) return { error: "solver_error" };
      if (rj.status === "ready") {
        const sol = rj.solution ?? {};
        const token =
          (sol.token as string) ||
          (sol.gRecaptchaResponse as string) ||
          (sol.text as string) ||
          "";
        return token ? { token } : { error: "no_token" };
      }
    } catch {
      return { error: "poll_error" };
    }
  }
  return { error: "timeout" };
}

export const solveRoutes = new Hono<{ Bindings: Env; Variables: { agent_id?: string } }>();

solveRoutes.post("/v1/solve", optionalAuth, async (c) => {
  const agentId = c.get("agent_id");
  const paymentProof = c.req.header("X-Payment-Proof") ?? c.req.header("PAYMENT-SIGNATURE");
  if (!agentId && !paymentProof) {
    return c.json(
      {
        error: "payment_required",
        message:
          "Attach a Bearer API key (Authorization: Bearer ubr_...) or an x402 payment proof to use /v1/solve (metered per solve).",
        accepts: {
          scheme: "x402",
          network: (c.env as unknown as { X402_NETWORK_MODE?: string }).X402_NETWORK_MODE ?? "mainnet",
          recipients: [(c.env as unknown as { PAYMENT_RECIPIENT?: string }).PAYMENT_RECIPIENT].filter(Boolean),
        },
      },
      402,
    );
  }

  if (!c.env.CAPZY_KEY?.trim()) {
    return c.json({ error: "solver_unconfigured", message: "captcha solver is not configured on this server" }, 503);
  }

  let req: SolveRequestBody;
  try {
    req = await c.req.json<SolveRequestBody>();
  } catch {
    return c.json({ error: "invalid_json", message: "body must be JSON" }, 400);
  }
  const vendor = (req.vendor ?? "").trim();
  const taskType = CAPZY_TASK_TYPE[vendor];
  if (!taskType) {
    return c.json({ error: "vendor_unsupported", message: `no solver task type for vendor '${vendor}'`, vendor }, 400);
  }
  let websiteURL: string;
  try {
    websiteURL = new URL(req.url ?? "").toString();
  } catch {
    return c.json({ error: "invalid_url", message: "url is required" }, 400);
  }
  const websiteKey = SITEKEY_RE.exec(req.body ?? "")?.[1];
  if (!websiteKey) {
    return c.json({ error: "no_sitekey", message: "no data-sitekey found in body" }, 422);
  }

  const result = await solveViaCapzy(c.env, taskType, websiteURL, websiteKey, 120_000);
  if ("error" in result) {
    return c.json({ error: "solve_failed", reason: result.error, vendor }, 502);
  }

  // Meter the solve to the agent (toll + fair-comp markup), same ledger plane as
  // the residential proxy surcharge.
  const surchargeUsd = Number((c.env as unknown as { SOLVE_SURCHARGE_USD?: string }).SOLVE_SURCHARGE_USD ?? "0.003") || 0.003;
  let host = "captcha";
  try {
    host = new URL(websiteURL).hostname;
  } catch {
    /* keep default */
  }
  if (agentId) {
    await recordProxySurcharge(c.env, {
      agent_id: agentId,
      skill_id: host,
      endpoint_id: "solve",
      ledger_id: `solve-${agentId}-${crypto.randomUUID()}`,
      cost_usd: surchargeUsd,
    });
  }

  return c.json({ token: result.token, vendor, cost_usd: surchargeUsd, auth_used: agentId ? "api_key" : "x402" }, 200);
});
