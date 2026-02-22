"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth-context";

export function ApiKeyGenerator() {
  const { apiKey, agentName, register, isAuthenticated } = useAuth();
  const [name, setName] = useState("");
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleRegister() {
    if (!name.trim()) return;
    setError(null);
    setLoading(true);
    try {
      const result = await register(name.trim());
      setGeneratedKey(result.api_key);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function handleCopy(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Already registered — show key info
  if (isAuthenticated && !generatedKey) {
    return (
      <div className="p-6 rounded-2xl border border-emerald-500/20 bg-emerald-500/5">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2 h-2 rounded-full bg-emerald-500" />
          <span className="text-sm font-mono text-emerald-500">Registered as {agentName}</span>
        </div>
        <p className="text-sm text-text-muted">
          Your API key is stored locally. Use it in the <code className="text-text-secondary">Authorization</code> header.
        </p>
      </div>
    );
  }

  // Key just generated — show it once
  if (generatedKey) {
    return (
      <div className="space-y-4">
        <div className="p-6 rounded-2xl border border-orange-500/30 bg-orange-500/5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
            <span className="text-sm font-semibold text-orange-500">Save this key — it won&apos;t be shown again</span>
          </div>
          <div className="flex items-center gap-2 bg-surface-raised border border-border rounded-xl px-4 py-3 font-mono text-sm">
            <code className="flex-1 break-all text-text-primary">{generatedKey}</code>
            <button
              onClick={() => handleCopy(generatedKey)}
              className="shrink-0 px-3 py-1.5 rounded-lg bg-orange-500 text-white text-xs font-medium hover:bg-orange-600 transition-colors"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
        <div className="p-4 rounded-xl bg-surface-raised border border-border font-mono text-sm text-text-secondary">
          <div className="text-text-muted text-xs mb-2"># Set your API key</div>
          <button onClick={() => handleCopy(`export UNBROWSE_API_KEY="${generatedKey}"`)} className="text-left w-full hover:text-text-primary transition-colors">
            export UNBROWSE_API_KEY=&quot;{generatedKey}&quot;
          </button>
        </div>
      </div>
    );
  }

  // Registration form
  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleRegister()}
          placeholder="Agent name (e.g. my-research-agent)"
          className="flex-1 px-4 py-3 rounded-xl bg-surface-raised border border-border
                     text-sm font-mono text-text-primary placeholder:text-text-muted
                     focus:outline-none focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/20
                     transition-all"
        />
        <button
          onClick={handleRegister}
          disabled={loading || !name.trim()}
          className="px-6 py-3 rounded-xl bg-orange-500 text-white font-semibold text-sm
                     hover:bg-orange-600 active:scale-[0.98] transition-all
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "..." : "Get API Key"}
        </button>
      </div>
      {error && (
        <p className="text-sm text-red-400 font-mono">{error}</p>
      )}
    </div>
  );
}
