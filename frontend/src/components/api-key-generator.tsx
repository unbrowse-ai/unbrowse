"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { Key, Copy, Check, ShieldAlert, KeyRound } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://beta-api.unbrowse.ai";

export function ApiKeyGenerator() {
  const { apiKey, agentName, register, isAuthenticated } = useAuth();
  const [name, setName] = useState("");
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedEnv, setCopiedEnv] = useState(false);
  const [tosAccepted, setTosAccepted] = useState(true);
  const [currentTosVersion, setCurrentTosVersion] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/v1/tos/current`)
      .then(r => r.json() as Promise<{ version: string }>)
      .then((data) => setCurrentTosVersion(data.version))
      .catch(() => setCurrentTosVersion("2026-02-22-v1"));
  }, []);

  async function handleRegister() {
    if (!name.trim() || !tosAccepted || !currentTosVersion) return;
    setError(null);
    setLoading(true);
    try {
      const result = await register(name.trim(), currentTosVersion);
      setGeneratedKey(result.api_key);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function handleCopy(text: string, setter: (val: boolean) => void) {
    navigator.clipboard.writeText(text);
    setter(true);
    setTimeout(() => setter(false), 2000);
  }

  // Already registered — show key info
  if (isAuthenticated && !generatedKey) {
    return (
      <div className="p-6 rounded-2xl border border-border bg-surface-sunken shadow-sm">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2 h-2 rounded-full bg-text-primary" />
          <span className="text-sm font-medium font-mono text-text-primary">Registered as {agentName}</span>
        </div>
        <p className="text-sm text-text-secondary">
          Your API key is stored locally. Use it in the <code className="text-text-primary bg-surface border border-border px-1.5 py-0.5 rounded font-mono text-xs">Authorization</code> header.
        </p>
      </div>
    );
  }

  // Key just generated — show it once
  if (generatedKey) {
    return (
      <div className="space-y-4">
        <div className="p-6 rounded-2xl border border-border bg-surface-sunken shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <ShieldAlert className="w-5 h-5 text-text-primary" />
            <span className="text-base font-semibold text-text-primary">Save this key — it won&apos;t be shown again</span>
          </div>
          <div className="flex items-center gap-3 bg-surface border border-border rounded-xl px-4 py-3 font-mono text-sm shadow-sm">
            <KeyRound className="w-4 h-4 text-text-muted shrink-0" />
            <code className="flex-1 break-all text-text-primary font-medium">{generatedKey}</code>
            <button
              onClick={() => handleCopy(generatedKey, setCopied)}
              className="shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-text-primary text-surface text-xs font-medium hover:opacity-90 transition-colors"
            >
              {copied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
            </button>
          </div>
        </div>
        <div className="p-5 rounded-xl bg-surface border border-border font-mono text-sm text-text-secondary group transition-colors">
          <div className="flex items-center justify-between mb-2">
            <span className="text-text-muted text-xs font-medium uppercase tracking-wider">Set Environment Variable</span>
            <button 
              onClick={() => handleCopy(`export UNBROWSE_API_KEY="${generatedKey}"`, setCopiedEnv)}
              className="text-text-muted hover:text-text-primary transition-colors"
            >
              {copiedEnv ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
          <code className="text-text-primary block overflow-x-auto whitespace-nowrap">
            export UNBROWSE_API_KEY=&quot;{generatedKey}&quot;
          </code>
        </div>
      </div>
    );
  }

  // Registration form
  return (
    <div className="p-6 sm:p-8 rounded-2xl border border-border bg-surface shadow-sm">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-surface-raised flex items-center justify-center border border-border">
          <Key className="w-4 h-4 text-text-muted" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-text-primary">Get your free API key</h3>
          <p className="text-sm text-text-secondary">Start using Unbrowse in seconds.</p>
        </div>
      </div>
      
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleRegister()}
            placeholder="Agent name (e.g. my-research-agent)"
            className="flex-1 px-4 py-3 rounded-lg bg-surface border border-border
                       text-sm font-mono text-text-primary placeholder:text-text-muted
                       focus:outline-none focus:border-text-primary focus:ring-1 focus:ring-text-primary
                       transition-all shadow-sm"
          />
          <button
            onClick={handleRegister}
            disabled={loading || !name.trim() || !tosAccepted}
            className="px-6 py-3 rounded-lg bg-text-primary text-surface font-medium text-sm
                       hover:opacity-90 active:scale-[0.98] transition-all
                       disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {loading ? "Generating..." : "Generate Key"}
          </button>
        </div>
        
        <label className="flex items-center gap-3 cursor-pointer select-none group w-fit">
          <div className="relative flex items-center justify-center">
            <input
              type="checkbox"
              checked={tosAccepted}
              onChange={(e) => setTosAccepted(e.target.checked)}
              className="peer appearance-none w-4 h-4 border border-border rounded bg-surface checked:bg-text-primary checked:border-text-primary transition-all cursor-pointer"
            />
            <Check className="absolute w-3 h-3 text-surface opacity-0 peer-checked:opacity-100 pointer-events-none transition-opacity" strokeWidth={3} />
          </div>
          <span className="text-sm text-text-secondary group-hover:text-text-primary transition-colors">
            I agree to the{" "}
            <a href="/terms" target="_blank" rel="noopener noreferrer" className="text-text-primary font-medium hover:underline transition-colors">
              Terms of Service
            </a>
          </span>
        </label>
        
        {error && (
          <div className="p-3 rounded-lg bg-surface border border-border text-sm text-text-primary font-mono flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
            <p>{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}
