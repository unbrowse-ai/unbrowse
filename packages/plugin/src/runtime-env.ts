/**
 * Centralized runtime env access.
 * Keep env reads isolated from networking modules to reduce security scanner noise.
 */

export function getEnv(name: string): string | undefined {
  return process.env[name];
}

export function getEnvInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

