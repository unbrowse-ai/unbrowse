import { Hono } from "hono";
import type { Env } from "../types.js";
import { bearerAuth } from "../middleware/auth.js";
import { agentRateLimit } from "../middleware/rate-limit.js";

type TtsEnv = { Bindings: Env; Variables: { agent_id: string } };

export const ttsRoutes = new Hono<TtsEnv>();

// Auth on all TTS routes
ttsRoutes.use("/tts/*", bearerAuth);

// Rate limit: 30 TTS generations per minute per agent
ttsRoutes.use(
  "/tts/generate",
  agentRateLimit({ limit: 30, window: 60, prefix: "tts-gen" }),
);
ttsRoutes.use(
  "/tts/generate-segments",
  agentRateLimit({ limit: 30, window: 60, prefix: "tts-seg" }),
);

interface TtsGenerateBody {
  text: string;
  voice_id?: string;
  speed?: number;
  format?: "wav" | "mp3";
}

interface TtsSegment {
  text: string;
  start_s: number;
  duration_s: number;
}

interface TtsSegmentsBody {
  segments: TtsSegment[];
  voice_id?: string;
  speed?: number;
}

// POST /v1/tts/generate — synthesize text to audio via Cartesia
ttsRoutes.post("/tts/generate", async (c) => {
  const body = await c.req.json<TtsGenerateBody>();

  if (!body.text?.trim()) {
    return c.json({ error: "text is required" }, 400);
  }
  if (body.format && !["wav", "mp3"].includes(body.format)) {
    return c.json({ error: "format must be one of: wav, mp3" }, 400);
  }
  if (body.speed !== undefined && (body.speed < 0.1 || body.speed > 3)) {
    return c.json({ error: "speed must be between 0.1 and 3" }, 400);
  }

  const voiceId = body.voice_id || c.env.CARTESIA_VOICE_ID;
  if (!voiceId) return c.json({ error: "CARTESIA_VOICE_ID not configured and no voice_id supplied" }, 500);
  if (!c.env.CARTESIA_API_KEY) return c.json({ error: "CARTESIA_API_KEY not configured" }, 500);

  const response = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      "Cartesia-Version": "2025-04-16",
      "X-API-Key": c.env.CARTESIA_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model_id: "sonic-3",
      transcript: body.text,
      voice: { mode: "id", id: voiceId },
      output_format: {
        container: "wav",
        encoding: "pcm_f32le",
        sample_rate: 44100,
      },
      speed: "normal",
      generation_config: { speed: body.speed ?? 1, volume: 1 },
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "unknown error");
    return c.json(
      { error: `Cartesia API error: ${response.status}`, detail: err },
      502,
    );
  }

  return new Response(response.body, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Disposition": `attachment; filename="tts.wav"`,
    },
  });
});

// POST /v1/tts/generate-segments — batch synthesize segments, return base64 JSON
ttsRoutes.post("/tts/generate-segments", async (c) => {
  const body = await c.req.json<TtsSegmentsBody>();

  if (!Array.isArray(body.segments) || body.segments.length === 0) {
    return c.json({ error: "segments array is required and must not be empty" }, 400);
  }
  if (body.segments.length > 50) {
    return c.json({ error: "maximum 50 segments per request" }, 400);
  }
  for (const [i, seg] of body.segments.entries()) {
    if (!seg.text?.trim()) {
      return c.json({ error: `segments[${i}].text is required` }, 400);
    }
    if (typeof seg.start_s !== "number" || typeof seg.duration_s !== "number") {
      return c.json({ error: `segments[${i}] must have numeric start_s and duration_s` }, 400);
    }
  }

  const voiceId = body.voice_id || c.env.CARTESIA_VOICE_ID;
  if (!voiceId) return c.json({ error: "CARTESIA_VOICE_ID not configured and no voice_id supplied" }, 500);
  const apiKey = c.env.CARTESIA_API_KEY;
  if (!apiKey) return c.json({ error: "CARTESIA_API_KEY not configured" }, 500);

  const results = await Promise.all(
    body.segments.map(async (seg, i) => {
      const response = await fetch("https://api.cartesia.ai/tts/bytes", {
        method: "POST",
        headers: {
          "Cartesia-Version": "2025-04-16",
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model_id: "sonic-3",
          transcript: seg.text,
          voice: { mode: "id", id: voiceId },
          output_format: {
            container: "wav",
            encoding: "pcm_f32le",
            sample_rate: 44100,
          },
          speed: "normal",
          generation_config: { speed: body.speed ?? 1, volume: 1 },
        }),
      });

      if (!response.ok) {
        const err = await response.text().catch(() => "unknown error");
        return { index: i, error: `Cartesia API error: ${response.status} — ${err}` };
      }

      const buf = await response.arrayBuffer();
      const base64 = btoa(
        String.fromCharCode(...new Uint8Array(buf)),
      );
      return {
        index: i,
        start_s: seg.start_s,
        duration_s: seg.duration_s,
        audio_base64: base64,
        format: "wav" as const,
      };
    }),
  );

  const errors = results.filter((r) => "error" in r);
  if (errors.length === results.length) {
    return c.json({ error: "All segments failed", details: errors }, 502);
  }

  return c.json({ segments: results });
});
