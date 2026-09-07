"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { getConfiguredApiOrigin } from "@/lib/api-base";
import {
  classifyAuthStartStatus,
  TRANSIENT_AUTH_MESSAGE,
  INVALID_EMAIL_MESSAGE,
} from "@/lib/auth-errors";

interface AuthState {
  apiKey: string | null;
  agentId: string | null;
  agentName: string | null;
  email?: string | null;
  userId?: string | null;
}

interface AuthContextValue extends AuthState {
  register: (name: string, tosVersion: string) => Promise<{ agent_id: string; api_key: string }>;
  loginWithEmail: (email: string, opts?: { signal?: AbortSignal }) => Promise<{ token: string }>;
  consumeMagicToken: (
    token: string,
    opts?: { signal?: AbortSignal }
  ) => Promise<{ api_key: string; agent_id: string; user_id: string; email: string }>;
  pairLocalCli: (payload: {
    api_key: string;
    agent_id: string;
    agent_name?: string;
    email?: string;
    user_id?: string | null;
  }) => void;
  logout: () => void;
  isAuthenticated: boolean;
  // True once the client has read localStorage after mount. Any consumer gating
  // UX on `isAuthenticated` MUST treat `!hydrated` as a loading state, not a
  // logged-out state (otherwise the user sees a "Sign in" flash on every
  // navigation, before the first client render reads storage). Server-side
  // render always emits `hydrated: false`.
  hydrated: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "unbrowse_auth";
const API_URL = getConfiguredApiOrigin();

const EMPTY_AUTH: AuthState = {
  apiKey: null,
  agentId: null,
  agentName: null,
  email: null,
  userId: null,
};

/** Read persisted auth synchronously. Returns EMPTY_AUTH on the server (no
 *  window) and on any malformed/partial stored blob — never trusts a stale
 *  shape that could set apiKey:undefined. The lazy useState initializer below
 *  calls this on the very first client render so a logged-in user never flashes
 *  the logged-out view. */
function readStoredAuth(): AuthState {
  if (typeof window === "undefined") return EMPTY_AUTH;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return EMPTY_AUTH;
    const parsed = JSON.parse(stored) as Partial<AuthState> | null;
    if (!parsed || typeof parsed !== "object" || typeof parsed.apiKey !== "string") {
      return EMPTY_AUTH;
    }
    return {
      apiKey: parsed.apiKey ?? null,
      agentId: parsed.agentId ?? null,
      agentName: parsed.agentName ?? null,
      email: parsed.email ?? null,
      userId: parsed.userId ?? null,
    };
  } catch {
    return EMPTY_AUTH;
  }
}

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 300_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Lazy initializer reads localStorage on the very first client render, so a
  // logged-in user never renders the logged-out view for a tick after a nav.
  // The server still gets EMPTY_AUTH (no localStorage), so `hydrated`
  // distinguishes "loading" from "actually logged out".
  const [state, setState] = useState<AuthState>(readStoredAuth);
  const [hydrated, setHydrated] = useState<boolean>(false);

  useEffect(() => {
    // Re-read after mount to cover the SSR pass (where readStoredAuth returned
    // EMPTY_AUTH because window was undefined). Idempotent; only updates state
    // if the freshly-read shape actually differs from the current one.
    const fresh = readStoredAuth();
    setState((prev) =>
      prev.apiKey === fresh.apiKey && prev.agentId === fresh.agentId ? prev : fresh,
    );
    setHydrated(true);
  }, []);

  const persist = useCallback((next: AuthState) => {
    setState(next);
    if (next.apiKey) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const register = useCallback(async (name: string, tosVersion: string) => {
    const res = await fetch(`${API_URL}/v1/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, tos_version: tosVersion }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    const data = await res.json() as { agent_id: string; api_key: string };
    persist({
      apiKey: data.api_key,
      agentId: data.agent_id,
      agentName: name,
      email: null,
      userId: null,
    });
    return data;
  }, [persist]);

  const loginWithEmail = useCallback(
    async (email: string, opts?: { signal?: AbortSignal }) => {
      const trimmed = email.trim();
      if (!trimmed) throw new Error("Enter an email address.");
      let res: Response;
      try {
        res = await fetch(`${API_URL}/v1/auth/email/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: trimmed }),
          signal: opts?.signal,
        });
      } catch (err) {
        throw new Error(`Could not reach the sign-in service: ${(err as Error).message}`);
      }
      // Transient / server-side failures are not the user's fault — show a friendly,
      // retryable message instead of a cryptic raw status. The status→kind mapping is a
      // pure helper (classifyAuthStartStatus) so it is unit-testable on its own.
      const kind = classifyAuthStartStatus(res.status);
      if (kind === "transient") {
        throw new Error(TRANSIENT_AUTH_MESSAGE);
      }
      if (kind === "invalid") {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? INVALID_EMAIL_MESSAGE);
      }
      if (kind === "other") {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { token: string };
      if (!data?.token) throw new Error("Sign-in service did not return a token.");
      return { token: data.token };
    },
    []
  );

  const consumeMagicToken = useCallback(
    async (token: string, opts?: { signal?: AbortSignal }) => {
      if (!token) throw new Error("Missing sign-in token.");
      const start = Date.now();
      while (Date.now() - start < POLL_TIMEOUT_MS) {
        if (opts?.signal?.aborted) throw new Error("aborted");
        let res: Response;
        try {
          res = await fetch(
            `${API_URL}/v1/auth/email/poll?token=${encodeURIComponent(token)}`,
            { signal: opts?.signal }
          );
        } catch (err) {
          if ((err as Error).name === "AbortError") throw new Error("aborted");
          await sleep(POLL_INTERVAL_MS, opts?.signal);
          continue;
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        const body = (await res.json()) as {
          status: "pending" | "verified" | "expired";
          api_key?: string;
          agent_id?: string;
          user_id?: string;
          email?: string;
        };
        if (body.status === "expired") {
          throw new Error("This sign-in link expired. Request a new one.");
        }
        if (body.status === "verified") {
          if (!body.api_key || !body.agent_id || !body.user_id || !body.email) {
            throw new Error("Sign-in returned an incomplete payload.");
          }
          persist({
            apiKey: body.api_key,
            agentId: body.agent_id,
            agentName: body.email,
            email: body.email,
            userId: body.user_id,
          });
          return { api_key: body.api_key, agent_id: body.agent_id, user_id: body.user_id, email: body.email };
        }
        await sleep(POLL_INTERVAL_MS, opts?.signal);
      }
      throw new Error("Sign-in timed out. Try sending a new link.");
    },
    [persist]
  );

  const pairLocalCli = useCallback(
    (payload: {
      api_key: string;
      agent_id: string;
      agent_name?: string;
      email?: string;
      user_id?: string | null;
    }) => {
      if (!payload.api_key || !payload.agent_id) {
        throw new Error("CLI pairing returned an incomplete payload.");
      }
      persist({
        apiKey: payload.api_key,
        agentId: payload.agent_id,
        agentName: payload.email ?? payload.agent_name ?? payload.agent_id,
        email: payload.email ?? null,
        userId: payload.user_id ?? null,
      });
    },
    [persist]
  );

  const logout = useCallback(() => {
    persist({ apiKey: null, agentId: null, agentName: null, email: null, userId: null });
  }, [persist]);

  return (
    <AuthContext.Provider
      value={{
        ...state,
        hydrated,
        register,
        loginWithEmail,
        consumeMagicToken,
        pairLocalCli,
        logout,
        isAuthenticated: !!state.apiKey,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
