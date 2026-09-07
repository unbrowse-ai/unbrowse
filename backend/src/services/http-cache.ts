import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

function cacheKey(key: string): string {
  return `http-cache:${key}`;
}

export async function deleteHttpCache(env: Env, key: string): Promise<void> {
  await statsKV(env).delete(cacheKey(key)).catch(() => {});
}

export async function getOrSetHttpCache<T>(
  env: Env,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  const kv = statsKV(env);
  const raw = await kv.get(cacheKey(key)) as string | null;
  if (raw) {
    return JSON.parse(raw) as T;
  }

  const value = await load();
  await kv.put(cacheKey(key), JSON.stringify(value), { expirationTtl: ttlSeconds }).catch(() => {});
  return value;
}
