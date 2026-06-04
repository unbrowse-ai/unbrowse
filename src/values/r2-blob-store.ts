/**
 * r2-blob-store — the KV cache tier backed by Cloudflare R2 (now), portable to
 * EmergentDB later. R2 speaks the S3 API, so the adapter takes a minimal
 * object-store client rather than hard-wiring the AWS SDK — that keeps it testable
 * with a stub and swappable for EmergentDB by writing one more client.
 *
 * Content-addressed: the key is the sha256 hex of the value (the resolution-ledger
 * computes it), so the same content resolves to the same object on any host and the
 * store is an immutable layer cache — exactly the Docker-layer property, one altitude
 * out over the network.
 */
import type { AsyncBlobStore } from "./async-resolution.js";

/** The minimal surface of an S3-compatible object store (Cloudflare R2, MinIO, …).
 *  `get` resolves to the object's text body or null when the key is absent. */
export interface ObjectStoreClient {
  get(key: string): Promise<string | null>;
  put(key: string, body: string): Promise<void>;
}

/** A content-addressed AsyncBlobStore over an S3-compatible object store. Keys are
 *  namespaced under `prefix` (default `resolution/`) so the bucket can be shared. */
export function r2BlobStore(client: ObjectStoreClient, prefix = "resolution/"): AsyncBlobStore {
  const k = (hex: string) => `${prefix}${hex}`;
  return {
    async get(hex) {
      return (await client.get(k(hex))) ?? undefined;
    },
    async put(hex, text) {
      await client.put(k(hex), text);
    },
  };
}

/**
 * Build an ObjectStoreClient from Cloudflare R2 credentials using the S3 REST API via
 * fetch (no AWS SDK dependency). Returns null when credentials are absent, so callers
 * fall back to the local fs tier. The actual SigV4 signing is delegated to a provided
 * `signedFetch` (so the heavy crypto lives in one tested place); without it this throws
 * a clear error rather than silently mis-signing.
 */
export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}
export function r2ConfigFromEnv(env: Record<string, string | undefined> = process.env): R2Config | null {
  const accountId = env.R2_ACCOUNT_ID;
  const bucket = env.R2_BUCKET;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { accountId, bucket, accessKeyId, secretAccessKey };
}
