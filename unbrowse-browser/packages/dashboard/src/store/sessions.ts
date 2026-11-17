"use client";

import { type Setter, atom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import { useAtomCallback } from "jotai/utils";
import type { SessionInfo } from "@/types";
import { type ExecResult, execCommand, killSession, sessionArgs } from "@/lib/exec";
import { getDashboardApiPath, getSessionTabsPath } from "@/lib/dashboard-routes";
import { tabCacheAtom, engineCacheAtom } from "@/store/tabs";
import { streamTabsAtom, streamEngineAtom } from "@/store/stream";
import { forgetChatFor } from "@/store/chat-book";
import {
  type ClosingSessions,
  type PendingSession,
  endSession,
  nextActivePort,
  omitPorts,
  settleClosing,
  settlePending,
  stalePorts,
} from "@/lib/session-lifecycle";

function getPort(): number {
  if (typeof window === "undefined") return 0;
  const params = new URLSearchParams(window.location.search);
  const portParam = params.get("port");
  const port = portParam ? Number.parseInt(portParam, 10) : 0;
  return Number.isInteger(port) && port > 0 ? port : 0;
}

export const newSessionDialogAtom = atom(false);

function getSessionsUrl(): string {
  return getDashboardApiPath("/api/sessions");
}

// ---------------------------------------------------------------------------
// Primitive atoms
// ---------------------------------------------------------------------------

export const activePortAtom = atom(getPort());

export const polledSessionsAtom = atom<SessionInfo[]>([]);

export const pendingSessionsAtom = atom<PendingSession[]>([]);

export const closingSessionsAtom = atom<ClosingSessions>({});

/** Why the last close or kill was refused. */
export const sessionErrorAtom = atom("");

// ---------------------------------------------------------------------------
// Derived atoms
// ---------------------------------------------------------------------------

export const sessionsAtom = atom((get) => {
  const polled = get(polledSessionsAtom);
  const pending = get(pendingSessionsAtom);
  const closing = get(closingSessionsAtom);

  const polledNames = new Set(polled.map((s) => s.session));
  const pendingEntries = pending
    .filter((p) => !polledNames.has(p.session))
    .map((p) => ({
      session: p.session,
      port: 0,
      engine: p.engine,
      provider: p.provider,
      pending: true as const,
    }));
  const merged = polled.map((s) =>
    s.session in closing ? { ...s, closing: true as const } : s,
  );
  return [...merged, ...pendingEntries];
});

export const activeSessionInfoAtom = atom((get) => {
  const sessions = get(sessionsAtom);
  const port = get(activePortAtom);
  return sessions.find((s) => s.port === port);
});

export const activeSessionNameAtom = atom(
  (get) => get(activeSessionInfoAtom)?.session ?? "",
);

export const activeExtensionsAtom = atom((get) => {
  const info = get(activeSessionInfoAtom);
  return (
    (info && "extensions" in info ? info.extensions : undefined) ?? []
  );
});

// ---------------------------------------------------------------------------
// Action atoms
// ---------------------------------------------------------------------------

export const createSessionAtom = atom(
  null,
  async (
    _get,
    set,
    { name, engine, provider }: { name: string; engine: string; provider?: string },
  ): Promise<string | null> => {
    set(pendingSessionsAtom, (prev) => [
      ...prev,
      { session: name, engine, provider, since: Date.now() },
    ]);
    const args = ["--session", name];
    if (provider) {
      args.push("--provider", provider);
    } else {
      args.push("--engine", engine);
    }
    args.push("open", "https://agent-browser.dev");
    const result = await execCommand(args);
    if (!result.success) {
      set(pendingSessionsAtom, (prev) => prev.filter((p) => p.session !== name));
      killSession(name);
      return parseExecError(result) || "Failed to create session";
    }
    const answeredAt = Date.now();
    set(pendingSessionsAtom, (prev) =>
      prev.map((p) => (p.session === name ? { ...p, answeredAt } : p)),
    );
    return null;
  },
);

function parseExecError(result: ExecResult): string {
  if (result.stderr) return result.stderr;
  if (result.stdout) {
    try {
      const json = JSON.parse(result.stdout);
      if (json.error) return json.error;
    } catch {
      // stdout wasn't JSON
    }
  }
  return "";
}

/** Runs a close or kill, leaving "Closing..." only while it can still be true. */
function endNamedSession(
  set: Setter,
  name: string,
  end: () => Promise<{ ok: boolean; error?: string }>,
): Promise<void> {
  const unmark = (prev: ClosingSessions) => {
    const { [name]: _gone, ...rest } = prev;
    return rest;
  };
  return endSession(end, {
    started: () => {
      set(sessionErrorAtom, "");
      set(closingSessionsAtom, (prev) => ({ ...prev, [name]: Date.now() }));
    },
    refused: (why) => {
      set(closingSessionsAtom, unmark);
      set(sessionErrorAtom, `${name}: ${why}`);
    },
    ended: () => forgetChatFor(name),
  });
}

const closeCommand = (name: string) => async () => {
  const result = await execCommand(sessionArgs(name, "close"));
  return { ok: result.success, error: parseExecError(result) };
};

const killCommand = (name: string) => async () => {
  const result = await killSession(name);
  return { ok: result.success === true, error: result.error };
};

export const closeSessionAtom = atom(null, (get, set, port: number) => {
  const sessions = get(sessionsAtom);
  const s = sessions.find((x) => x.port === port)?.session;
  if (s) endNamedSession(set, s, closeCommand(s));
});

export const killSessionAtom = atom(null, (get, set, port: number) => {
  const sessions = get(sessionsAtom);
  const s = sessions.find((x) => x.port === port)?.session;
  if (s) endNamedSession(set, s, killCommand(s));
});

export const closeAllSessionsAtom = atom(null, (get, set) => {
  const sessions = get(sessionsAtom);
  for (const s of sessions) {
    if (!s.pending && !s.closing) {
      endNamedSession(set, s.session, closeCommand(s.session));
    }
  }
});

export const closeTabAtom = atom(
  null,
  (get, _set, { port, tabRef }: { port: number; tabRef: string }) => {
    const sessions = get(sessionsAtom);
    const s = sessions.find((x) => x.port === port)?.session;
    if (s) execCommand(sessionArgs(s, "tab", "close", tabRef));
  },
);

export const addTabAtom = atom(null, (get, _set, port: number) => {
  const sessions = get(sessionsAtom);
  const s = sessions.find((x) => x.port === port)?.session;
  if (s) execCommand(sessionArgs(s, "tab", "new"));
});

export const switchTabAtom = atom(
  null,
  (get, _set, { port, tabRef }: { port: number; tabRef: string }) => {
    const sessions = get(sessionsAtom);
    const s = sessions.find((x) => x.port === port)?.session;
    if (s) execCommand(sessionArgs(s, "tab", tabRef));
  },
);

/**
 * Prunes pending/closing by what the poll saw, or by time alone when `listed`
 * is null because the poll failed.
 */
const reconcileSessionsAtom = atom(null, (_get, set, listed: Set<string> | null) => {
  const now = Date.now();
  set(pendingSessionsAtom, (prev) => settlePending(prev, listed, now));
  set(closingSessionsAtom, (prev) => settleClosing(prev, listed, now));
});

// ---------------------------------------------------------------------------
// Sync hook
// ---------------------------------------------------------------------------

export function useSessionsSync(pollInterval = 5000) {
  const failCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const portOwnersRef = useRef<Record<number, string>>({});

  const reconcile = useAtomCallback(
    useCallback((_get, set, listed: Set<string> | null) => {
      set(reconcileSessionsAtom, listed);
    }, []),
  );

  const fetchSessions = useAtomCallback(
    useCallback(
      async (get, set) => {
        try {
          const resp = await fetch(getSessionsUrl());
          if (resp.ok) {
            failCountRef.current = 0;
            const data: SessionInfo[] = await resp.json();
            data.sort((a, b) => a.session.localeCompare(b.session));
            set(polledSessionsAtom, data);

            // Reconcile pending/closing
            reconcile(new Set(data.map((s) => s.session)));

            // What was cached for a port that changed hands isn't this session's
            const { owners, stale } = stalePorts(portOwnersRef.current, data);
            portOwnersRef.current = owners;
            if (stale.length > 0) {
              set(tabCacheAtom, (prev) => omitPorts(prev, stale));
              set(engineCacheAtom, (prev) => omitPorts(prev, stale));
            }

            // Seed engine cache from session list
            const engineCache = get(engineCacheAtom);
            const nextEngine = { ...engineCache };
            let engineChanged = false;
            for (const s of data) {
              if (s.engine && !nextEngine[s.port]) {
                nextEngine[s.port] = s.engine;
                engineChanged = true;
              }
            }
            if (engineChanged) set(engineCacheAtom, nextEngine);

            // Auto-select first session if current port is not in list
            const activePort = get(activePortAtom);
            const nextPort = nextActivePort(activePort, get(sessionsAtom));
            if (nextPort !== activePort) set(activePortAtom, nextPort);

            // Poll tabs for all sessions
            for (const s of data) {
              try {
                const tabsResp = await fetch(getSessionTabsPath(s.port)).catch(
                  () => null,
                );
                if (tabsResp?.ok) {
                  const tabs = await tabsResp.json();
                  if (Array.isArray(tabs)) {
                    set(tabCacheAtom, (prev) => ({ ...prev, [s.port]: tabs }));
                  }
                }
              } catch {
                // Session unreachable
              }
            }

            return;
          }
        } catch {
          // Server unreachable
        }
        failCountRef.current++;
        if (failCountRef.current >= 2) set(polledSessionsAtom, []);
        reconcile(null);
      },
      [reconcile],
    ),
  );

  useEffect(() => {
    fetchSessions();
    timerRef.current = setInterval(fetchSessions, pollInterval);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchSessions, pollInterval]);
}
