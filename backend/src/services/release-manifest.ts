import type { Env } from "../types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ReleaseManifestPayload {
  schema_version: 1;
  release_version: string;
  git_sha: string;
  code_hash: string;
  trace_version: string;
  issued_at: string;
}

export interface ReleaseManifestVerification {
  provided: boolean;
  verified: boolean;
  reason: string;
  manifest?: ReleaseManifestPayload;
}

function normalizeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  return padding === 0 ? normalized : normalized + "=".repeat(4 - padding);
}

function decodeBase64UrlBytes(input: string): Uint8Array | null {
  try {
    const normalized = normalizeBase64Url(input.trim());
    const raw = atob(normalized);
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeBase64UrlText(input: string): string | null {
  const bytes = decodeBase64UrlBytes(input);
  if (!bytes) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function isManifestPayload(value: unknown): value is ReleaseManifestPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schema_version === 1
    && typeof candidate.release_version === "string"
    && typeof candidate.git_sha === "string"
    && typeof candidate.code_hash === "string"
    && typeof candidate.trace_version === "string"
    && typeof candidate.issued_at === "string";
}

export async function verifyReleaseManifest(
  env: Pick<Env, "RELEASE_MANIFEST_SIGNING_SECRET">,
  manifestHeader?: string,
  signatureHeader?: string,
  expected?: {
    trace_version?: string;
    code_hash?: string;
    git_sha?: string;
  },
): Promise<ReleaseManifestVerification> {
  const provided = Boolean(manifestHeader || signatureHeader);
  if (!provided) {
    return { provided: false, verified: false, reason: "missing" };
  }
  if (!manifestHeader || !signatureHeader) {
    return { provided: true, verified: false, reason: "incomplete" };
  }

  const manifestJson = decodeBase64UrlText(manifestHeader);
  if (!manifestJson) {
    return { provided: true, verified: false, reason: "invalid_manifest_encoding" };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestJson);
  } catch {
    return { provided: true, verified: false, reason: "invalid_manifest_json" };
  }
  if (!isManifestPayload(manifest)) {
    return { provided: true, verified: false, reason: "invalid_manifest_shape" };
  }

  if (!env.RELEASE_MANIFEST_SIGNING_SECRET) {
    return {
      provided: true,
      verified: false,
      reason: "verification_unconfigured",
      manifest,
    };
  }

  const providedSignature = decodeBase64UrlBytes(signatureHeader);
  if (!providedSignature) {
    return { provided: true, verified: false, reason: "invalid_signature_encoding", manifest };
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.RELEASE_MANIFEST_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expectedSignature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(manifestJson)),
  );
  if (!constantTimeEqual(expectedSignature, providedSignature)) {
    return { provided: true, verified: false, reason: "signature_mismatch", manifest };
  }

  if (expected?.trace_version && manifest.trace_version !== expected.trace_version) {
    return { provided: true, verified: false, reason: "trace_version_mismatch", manifest };
  }
  if (expected?.code_hash && manifest.code_hash !== expected.code_hash) {
    return { provided: true, verified: false, reason: "code_hash_mismatch", manifest };
  }
  if (expected?.git_sha && manifest.git_sha !== expected.git_sha) {
    return { provided: true, verified: false, reason: "git_sha_mismatch", manifest };
  }

  return { provided: true, verified: true, reason: "verified", manifest };
}
