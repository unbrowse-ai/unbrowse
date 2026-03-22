export function parsePortListenerPids(text: string, blocked: number[] = []): number[] {
  const blockedSet = new Set(blocked);
  const pids = new Set<number>();

  for (const line of text.trim().split("\n")) {
    const pid = Number(line.trim());
    if (!Number.isFinite(pid) || pid <= 0 || blockedSet.has(pid)) continue;
    pids.add(pid);
  }

  return [...pids];
}
