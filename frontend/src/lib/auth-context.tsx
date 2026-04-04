"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { registerAgent, verifyAgentApiKey } from "@/lib/api";

interface AuthState {
  apiKey: string | null;
  agentId: string | null;
  agentName: string | null;
}

interface AuthContextValue extends AuthState {
  register: (name: string, tosVersion: string) => Promise<{ agent_id: string; api_key: string }>;
  loginWithApiKey: (apiKey: string) => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
}

const STORAGE_KEY = "unbrowse_auth";
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ apiKey: null, agentId: null, agentName: null });

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setState(JSON.parse(stored) as AuthState);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
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
    const data = await registerAgent(name, tosVersion);
    persist({ apiKey: data.api_key, agentId: data.agent_id, agentName: name });
    return data;
  }, [persist]);

  const loginWithApiKey = useCallback(async (apiKey: string) => {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new Error("API key is required");
    const profile = await verifyAgentApiKey(trimmed);
    persist({
      apiKey: trimmed,
      agentId: profile.agent_id,
      agentName: profile.name,
    });
  }, [persist]);

  const logout = useCallback(() => {
    persist({ apiKey: null, agentId: null, agentName: null });
  }, [persist]);

  return (
    <AuthContext.Provider
      value={{
        ...state,
        register,
        loginWithApiKey,
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
