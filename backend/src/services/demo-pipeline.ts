import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

// --- Types ---

export interface DemoRequest {
  repo_url: string;
  start_cmd?: string;
  url?: string;
  nav?: Array<{ action: string; [key: string]: unknown }>;
  avatar_image_url?: string;
  voice?: "minimax" | "elevenlabs" | "espeak";
  aspect_ratio?: "16:9" | "9:16";
  tier?: "basic" | "standard" | "premium";
  webhook_url?: string;
}

export interface DemoJob {
  job_id: string;
  agent_id: string;
  status: DemoJobStatus;
  created_at: string;
  request: DemoRequest;
  outputs?: DemoOutputs;
  cost_cents?: number;
  error?: string;
}

export type DemoJobStatus =
  | "queued"
  | "creating_sandbox"
  | "recording"
  | "narrating"
  | "compositing"
  | "uploading"
  | "done"
  | "failed";

export interface DemoOutputs {
  video_url?: string;
  thumbnail_url?: string;
  narration_url?: string;
  duration_ms?: number;
}

// --- KV helpers ---

const JOB_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

async function getJob(env: Env, jobId: string): Promise<DemoJob | null> {
  const raw = await statsKV(env).get(`demo:${jobId}`) as string | null;
  if (!raw) return null;
  return JSON.parse(raw) as DemoJob;
}

async function putJob(env: Env, job: DemoJob): Promise<void> {
  await statsKV(env).put(`demo:${job.job_id}`, JSON.stringify(job), {
    expirationTtl: JOB_TTL_SECONDS,
  });
}

// --- Turbobox helpers ---

interface SandboxResult {
  id: string;
}

async function createSandbox(env: Env): Promise<SandboxResult> {
  const res = await fetch(`${env.TURBOBOX_URL}/v1/boxes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: "ubuntu:22.04", timeout: 600 }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create sandbox: ${res.status} ${body}`);
  }
  return (await res.json()) as SandboxResult;
}

async function execInSandbox(
  env: Env,
  boxId: string,
  cmd: string,
  timeout = 120_000,
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  const res = await fetch(`${env.TURBOBOX_URL}/v1/boxes/${boxId}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd, timeout }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sandbox exec failed: ${res.status} ${body}`);
  }
  return (await res.json()) as { exit_code: number; stdout: string; stderr: string };
}

async function destroySandbox(env: Env, boxId: string): Promise<void> {
  try {
    await fetch(`${env.TURBOBOX_URL}/v1/boxes/${boxId}`, { method: "DELETE" });
  } catch {
    // Best-effort cleanup — sandbox will auto-expire anyway
  }
}

async function uploadToR2(
  env: Env,
  key: string,
  data: ArrayBuffer | Uint8Array,
  contentType = "video/mp4",
): Promise<string> {
  await env.R2_BUCKET.put(key, data, {
    httpMetadata: { contentType },
  });
  // Return a public URL — assumes R2 bucket has a custom domain or public access
  return `https://demos.unbrowse.ai/${key}`;
}

// --- Pipeline ---

export async function runDemoPipeline(
  env: Env,
  jobId: string,
  request: DemoRequest,
): Promise<void> {
  const job = await getJob(env, jobId);
  if (!job) return;

  const tier = request.tier ?? "basic";

  const updateStatus = async (
    status: DemoJobStatus,
    extras?: Partial<Pick<DemoJob, "outputs" | "cost_cents" | "error">>,
  ) => {
    job.status = status;
    if (extras) Object.assign(job, extras);
    await putJob(env, job);
  };

  // 1. Create sandbox
  await updateStatus("creating_sandbox");
  const box = await createSandbox(env);

  try {
    // 2. Clone repo and set up recording environment
    await updateStatus("recording");
    await execInSandbox(
      env,
      box.id,
      `git clone --depth 1 ${request.repo_url} /workspace && cd /workspace`,
      60_000,
    );

    // Run start command if provided
    if (request.start_cmd) {
      await execInSandbox(
        env,
        box.id,
        `cd /workspace && ${request.start_cmd}`,
        120_000,
      );
    }

    // 3. Run screen recording with navigation
    const navJson = JSON.stringify(request.nav ?? []);
    const aspect = request.aspect_ratio ?? "16:9";
    await execInSandbox(
      env,
      box.id,
      [
        "cd /workspace &&",
        "demo-recorder",
        `--url '${request.url ?? "http://localhost:3000"}'`,
        `--nav '${navJson}'`,
        `--aspect '${aspect}'`,
        "--output /tmp/recording.mp4",
      ].join(" "),
      300_000,
    );

    // 4. Narration (tier >= standard)
    if (tier === "standard" || tier === "premium") {
      await updateStatus("narrating");
      const voice = request.voice ?? "minimax";
      await execInSandbox(
        env,
        box.id,
        [
          "demo-narrator",
          "--input /tmp/recording.mp4",
          `--voice '${voice}'`,
          `--fal-key '${env.FAL_KEY}'`,
          "--output-narration /tmp/narration.mp3",
          "--output-composite /tmp/composite.mp4",
        ].join(" "),
        180_000,
      );
    }

    // 5. Avatar overlay (tier == premium)
    if (tier === "premium" && request.avatar_image_url) {
      await updateStatus("compositing");
      await execInSandbox(
        env,
        box.id,
        [
          "demo-compositor",
          "--input /tmp/composite.mp4",
          `--avatar '${request.avatar_image_url}'`,
          "--output /tmp/final.mp4",
        ].join(" "),
        180_000,
      );
    }

    // 6. Pull outputs from sandbox via base64
    await updateStatus("uploading");

    const videoPath =
      tier === "premium" && request.avatar_image_url
        ? "/tmp/final.mp4"
        : tier !== "basic"
          ? "/tmp/composite.mp4"
          : "/tmp/recording.mp4";

    const videoResult = await execInSandbox(
      env,
      box.id,
      `base64 -w 0 ${videoPath}`,
      60_000,
    );
    const videoBytes = Uint8Array.from(atob(videoResult.stdout), (c) =>
      c.charCodeAt(0),
    );

    const videoKey = `demos/${jobId}/video.mp4`;
    const videoUrl = await uploadToR2(env, videoKey, videoBytes, "video/mp4");

    const outputs: DemoOutputs = { video_url: videoUrl };

    // Upload narration if it exists
    if (tier !== "basic") {
      try {
        const narrationResult = await execInSandbox(
          env,
          box.id,
          "base64 -w 0 /tmp/narration.mp3",
          30_000,
        );
        const narrationBytes = Uint8Array.from(
          atob(narrationResult.stdout),
          (c) => c.charCodeAt(0),
        );
        const narrationKey = `demos/${jobId}/narration.mp3`;
        outputs.narration_url = await uploadToR2(
          env,
          narrationKey,
          narrationBytes,
          "audio/mpeg",
        );
      } catch {
        // Narration is optional — don't fail the job
      }
    }

    // Generate thumbnail
    try {
      await execInSandbox(
        env,
        box.id,
        `ffmpeg -i ${videoPath} -ss 00:00:01 -vframes 1 -f image2 /tmp/thumb.jpg`,
        30_000,
      );
      const thumbResult = await execInSandbox(
        env,
        box.id,
        "base64 -w 0 /tmp/thumb.jpg",
        15_000,
      );
      const thumbBytes = Uint8Array.from(atob(thumbResult.stdout), (c) =>
        c.charCodeAt(0),
      );
      const thumbKey = `demos/${jobId}/thumb.jpg`;
      outputs.thumbnail_url = await uploadToR2(
        env,
        thumbKey,
        thumbBytes,
        "image/jpeg",
      );
    } catch {
      // Thumbnail is nice-to-have
    }

    // Estimate cost
    const costMap = { basic: 10, standard: 50, premium: 150 } as const;
    const costCents = costMap[tier] ?? 10;

    // 7. Done
    await updateStatus("done", { outputs, cost_cents: costCents });

    // 8. Webhook callback
    if (request.webhook_url) {
      try {
        await fetch(request.webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            job_id: jobId,
            status: "done",
            outputs,
          }),
        });
      } catch {
        // Webhook delivery is best-effort
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateStatus("failed", { error: message });

    // Webhook on failure too
    if (request.webhook_url) {
      try {
        await fetch(request.webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            job_id: jobId,
            status: "failed",
            error: message,
          }),
        });
      } catch {
        // Best-effort
      }
    }
  } finally {
    // Always destroy sandbox
    await destroySandbox(env, box.id);
  }
}

export { getJob, putJob };
