"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

interface AuthState {
  apiKey: string | null;
  agentId: string | null;
  agentName: string | null;
}

interface AuthContextValue extends AuthState {
  register: (name: string, tosVersion?: string) => Promise<{ agent_id: string; api_key: string }>;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "unbrowse_auth";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://beta-api.unbrowse.ai";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ apiKey: null, agentId: null, agentName: null });

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setState(JSON.parse(stored));
    } catch { /* ignore */ }
  }, []);

  const persist = useCallback((next: AuthState) => {
    setState(next);
    if (next.apiKey) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const register = useCallback(async (name: string, tosVersion?: string) => {
    const res = await fetch(`${API_URL}/v1/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        ...(tosVersion ? { tos_version: tosVersion } : {}),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    const data = await res.json() as { agent_id: string; api_key: string };
    persist({ apiKey: data.api_key, agentId: data.agent_id, agentName: name });
    return data;
  }, [persist]);

  const logout = useCallback(() => {
    persist({ apiKey: null, agentId: null, agentName: null });
  }, [persist]);

  return (
    <AuthContext.Provider value={{ ...state, register, logout, isAuthenticated: !!state.apiKey }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
