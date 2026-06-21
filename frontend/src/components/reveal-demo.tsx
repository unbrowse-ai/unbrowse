"use client";

import { useCallback, useEffect, useState } from "react";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  deriveX25519Pubkey,
  sealToPubkey,
  revealForWallet,
  type SealedEnvelope,
  type SignMessage,
} from "@/lib/wallet-seal-reveal";

const DEMO_VALUE =
  "CONTRACT TERMS · settlement: 2.5% · payout wallet: 8n7Q…QGR8 · valid until 2026-12-31 · clause 7: render only to the bound wallet";

/** A throwaway in-browser keypair standing in for a connected wallet (demo-only). */
function ephemeralWallet(): SignMessage {
  const seed = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return async (msg: Uint8Array) => ed25519.sign(msg, seed);
}

type Phase = "sealing" | "sealed" | "revealing" | "revealed" | "denied";

export function RevealDemo() {
  const [owner] = useState<SignMessage>(() => ephemeralWallet());
  const [envelope, setEnvelope] = useState<SealedEnvelope | null>(null);
  const [phase, setPhase] = useState<Phase>("sealing");
  const [value, setValue] = useState<string | null>(null);

  // Seal the sample value to the demo wallet on mount — this is what a server would persist:
  // an opaque envelope it cannot read. The plaintext exists only inside this seal step.
  useEffect(() => {
    let alive = true;
    (async () => {
      const pub = await deriveX25519Pubkey(owner);
      const env = await sealToPubkey(pub, DEMO_VALUE);
      if (alive) { setEnvelope(env); setPhase("sealed"); }
    })();
    return () => { alive = false; };
  }, [owner]);

  const revealAsOwner = useCallback(async () => {
    if (!envelope) return;
    setPhase("revealing"); setValue(null);
    try {
      const plain = await revealForWallet(owner, envelope); // signs in-browser, decrypts client-side
      setValue(plain); setPhase("revealed");
    } catch {
      setPhase("sealed");
    }
  }, [envelope, owner]);

  const revealAsIntruder = useCallback(async () => {
    if (!envelope) return;
    setPhase("revealing"); setValue(null);
    try {
      const plain = await revealForWallet(ephemeralWallet(), envelope); // a DIFFERENT wallet
      setValue(plain); setPhase("revealed"); // should never happen
    } catch {
      setPhase("denied"); // AES-GCM auth-tag fails — the wallet-gate held
    }
  }, [envelope]);

  return (
    <div className="space-y-6">
      {/* What the server holds */}
      <section className="rounded-2xl border border-border bg-surface-sunken p-5 space-y-3">
        <h2 className="text-sm font-medium text-text-primary">1 · What the server stores (and cannot read)</h2>
        <p className="text-sm text-text-primary/70">
          The value is sealed to your wallet&rsquo;s key. The server only ever holds this opaque envelope —
          no plaintext, no decryption key. <span className="text-text-primary">Render-without-seeing.</span>
        </p>
        <pre className="rounded-lg border border-border bg-surface p-3 text-xs font-mono text-text-primary/80 overflow-x-auto whitespace-pre-wrap break-all">
          {envelope
            ? JSON.stringify({ senderPub: envelope.senderPub, iv: envelope.iv, ciphertext: envelope.ciphertext }, null, 2)
            : "sealing…"}
        </pre>
      </section>

      {/* The reveal */}
      <section className="rounded-2xl border border-border bg-surface-sunken p-5 space-y-4">
        <h2 className="text-sm font-medium text-text-primary">2 · Reveal — only the bound wallet can</h2>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={revealAsOwner}
            disabled={!envelope || phase === "revealing"}
            className="rounded-xl bg-text-primary px-4 py-2 text-sm font-medium text-surface disabled:opacity-50 transition hover:opacity-90"
          >
            {phase === "revealing" ? "Authenticating…" : "Authenticate with your wallet & reveal"}
          </button>
          <button
            onClick={revealAsIntruder}
            disabled={!envelope || phase === "revealing"}
            className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-text-primary disabled:opacity-50 transition hover:bg-surface"
          >
            Try as a different wallet
          </button>
        </div>

        {phase === "revealed" && value && (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
            <div className="text-xs uppercase tracking-wide text-emerald-500 mb-1">Rendered for the bound wallet</div>
            <div className="text-sm font-mono text-text-primary break-words">{value}</div>
          </div>
        )}
        {phase === "denied" && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-4">
            <div className="text-xs uppercase tracking-wide text-red-500 mb-1">Access denied</div>
            <div className="text-sm text-text-primary/80">
              This wallet is not the one the value was sealed to. The decryption auth-tag fails — the value
              never renders. No server check; the math itself is the gate.
            </div>
          </div>
        )}
      </section>

      <p className="text-xs text-text-primary/50">
        Demo wallet is generated in your browser for this page only. Production sealing happens server-side
        (IQLabs on-chain, wallet-signed); the reveal is always client-side, by the wallet bound to the value.
      </p>
    </div>
  );
}
