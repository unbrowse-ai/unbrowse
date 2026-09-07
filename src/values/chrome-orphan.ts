/**
 * chrome-orphan — which unbrowse-managed Chrome processes are safe to reap?
 *
 * Background captures spawn Chrome detached (the session model requires detach,
 * so an `unbrowse go` page survives a one-shot CLI). In-process teardown covers
 * the polite exits — done, error, deadline, SIGTERM/SIGINT/SIGHUP. It cannot
 * cover SIGKILL, because no handler runs, and SIGKILL is exactly what the OOM
 * killer sends.
 *
 * That is not hypothetical: 119 orphaned unbrowse-Chrome processes were measured
 * on this machine holding 7.3GB with NO driver running, after the machine ran out
 * of memory mid-run. Memory went to 580MB free and a whole sites100 run timed out
 * on sites that answer curl in 35ms.
 *
 * So the backstop cannot live inside the process that dies. It is reap-on-read:
 * a later invocation decides, from durable evidence only (pid liveness, session
 * records, process age). Same shape as the bg-capture slot reaper, which is the
 * one mechanism that survived every failure this session.
 *
 * Pure: takes a snapshot, returns pids. No I/O, no clock — the caller supplies
 * `now` — so every branch is exhaustively testable without spawning a browser.
 */

export interface ChromeProcSnapshot {
  /** OS process id. */
  pid: number;
  /** Milliseconds since the process started. */
  ageMs: number;
  /** True when a live browse-session record claims this pid. */
  sessionOwned: boolean;
}

export interface ReapPolicy {
  /**
   * Minimum age before a process is even considered. A capture legitimately
   * takes minutes, and a session record is written slightly AFTER Chrome comes
   * up — this window is what keeps a brand-new session from being reaped in the
   * gap before its record lands on disk.
   */
  minAgeMs: number;
}

export const DEFAULT_REAP_POLICY: ReapPolicy = {
  // 15 minutes: comfortably past the 180s background-capture deadline, so a
  // capture that is merely slow is never mistaken for an orphan.
  minAgeMs: 15 * 60 * 1000,
};

/**
 * Pids safe to terminate.
 *
 * Fails CLOSED in every ambiguous direction — a process is reaped only when it
 * is positively known to be unowned AND old. Anything unknown is left running,
 * because the cost of leaving a process is bounded memory, while the cost of
 * killing a live session is a user losing their logged-in browser.
 */
export function selectReapableChrome(
  procs: readonly ChromeProcSnapshot[],
  policy: ReapPolicy = DEFAULT_REAP_POLICY,
): number[] {
  const out: number[] = [];
  for (const p of procs) {
    if (!Number.isInteger(p.pid) || p.pid <= 1) continue; // never pid 0/1, never junk
    if (p.sessionOwned) continue;                          // a browse session owns it
    if (!Number.isFinite(p.ageMs) || p.ageMs < policy.minAgeMs) continue;
    out.push(p.pid);
  }
  return out;
}
