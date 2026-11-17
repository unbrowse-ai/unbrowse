/**
 * The rules for a session's rows while it starts and ends. A row saying
 * "Starting..." or "Closing..." offers no menu, so each of those states needs a
 * way out that doesn't depend on the session list ever confirming it: the
 * command's own answer, and failing that, time.
 */

export interface PendingSession {
  session: string;
  engine: string;
  provider?: string;
  since: number;
  /** When the start command answered. The poll should list it soon after. */
  answeredAt?: number;
}

/** Session name to when its close began. */
export type ClosingSessions = Record<string, number>;

/** Polls are 5s apart, so three of them have had their chance to list a session. */
export const LISTED_WITHIN_MS = 15_000;
/** A start can take a browser launch and a page load; past this it isn't coming. */
export const START_LIMIT_MS = 180_000;
/** Past this the row gives its menu back, so the person can try again or kill it. */
export const CLOSE_LIMIT_MS = 45_000;

/**
 * The rows still starting. `listed` is null when the poll failed: nothing was
 * learned about the sessions, only that time passed.
 */
export function settlePending(
  pending: PendingSession[],
  listed: Set<string> | null,
  now: number,
): PendingSession[] {
  const next = pending.filter((p) => {
    if (listed?.has(p.session)) return false;
    if (p.answeredAt !== undefined) return now - p.answeredAt < LISTED_WITHIN_MS;
    return now - p.since < START_LIMIT_MS;
  });
  return next.length === pending.length ? pending : next;
}

/** The rows still closing: not yet gone from the list, and not out of time. */
export function settleClosing(
  closing: ClosingSessions,
  listed: Set<string> | null,
  now: number,
): ClosingSessions {
  const names = Object.keys(closing);
  const kept = names.filter((name) => {
    if (listed && !listed.has(name)) return false;
    return now - closing[name] < CLOSE_LIMIT_MS;
  });
  if (kept.length === names.length) return closing;
  return Object.fromEntries(kept.map((name) => [name, closing[name]]));
}

/**
 * Ends a session through `end` and acts on its answer. Saying "Closing..." is
 * right only while the command runs, and a chat is forgotten only once the
 * session is really gone: a refused close leaves a live session and its chat.
 */
export async function endSession(
  end: () => Promise<{ ok: boolean; error?: string }>,
  on: { started: () => void; refused: (why: string) => void; ended: () => void },
): Promise<void> {
  on.started();
  const answer = await end();
  if (answer.ok) on.ended();
  else on.refused(answer.error || "The session could not be closed");
}

interface ListedSession {
  session: string;
  port: number;
  pending?: boolean;
  closing?: boolean;
}

/**
 * The port to show. A session that is going is no better than the one that
 * went; with nothing left the answer is 0, which opens no stream.
 */
export function nextActivePort(active: number, sessions: ListedSession[]): number {
  if (sessions.some((s) => s.port === active)) return active;
  const live = sessions.find((s) => !s.pending && !s.closing);
  return live?.port ?? sessions[0]?.port ?? 0;
}

/**
 * Which ports' cached tabs and engine no longer describe their session. Ports
 * are the OS's to reuse: a port that left the list, or came back under another
 * name, says nothing about what it held before.
 */
export function stalePorts(
  owners: Record<number, string>,
  sessions: { session: string; port: number }[],
): { owners: Record<number, string>; stale: number[] } {
  const next: Record<number, string> = {};
  for (const s of sessions) next[s.port] = s.session;
  const stale = Object.keys(owners)
    .map(Number)
    .filter((port) => next[port] !== owners[port]);
  return { owners: next, stale };
}

export function omitPorts<T>(cache: Record<number, T>, ports: number[]): Record<number, T> {
  if (!ports.some((port) => port in cache)) return cache;
  const next = { ...cache };
  for (const port of ports) delete next[port];
  return next;
}
