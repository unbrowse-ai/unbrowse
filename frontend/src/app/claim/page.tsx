"use client";

import Link from "next/link";
import { useState } from "react";
import {
  buildOfficialSubmissionMailto,
  ClaimClientError,
  getStatus,
  getTakedownStatus,
  postChallenge,
  postSubmitOfficial,
  postTakedownChallenge,
  postTakedownVerify,
  postVerify,
  type ChallengeEnvelope,
  type ClaimStatus,
  type OfficialEndpointInput,
  type TakedownStatus,
} from "@/lib/claim-client";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function copyToClipboard(value: string): void {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    void navigator.clipboard.writeText(value);
  }
}

function ResultBlock({
  tone,
  children,
}: {
  tone: "ok" | "error" | "info";
  children: React.ReactNode;
}) {
  const palette =
    tone === "ok"
      ? "border-azure-400 bg-azure-50 text-text-primary"
      : tone === "error"
      ? "border-orange-300 bg-orange-50 text-text-primary"
      : "border-border bg-surface-sunken text-text-secondary";
  return (
    <div className={`rounded-lg border ${palette} p-4 text-sm`}>{children}</div>
  );
}

function TxtRecordReveal({ envelope }: { envelope: ChallengeEnvelope }) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-sunken p-4">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-text-muted">
          TXT record name
        </p>
        <div className="flex items-start justify-between gap-3">
          <code className="break-all font-mono text-xs text-text-primary">
            {envelope.txt_name}
          </code>
          <button
            type="button"
            onClick={() => copyToClipboard(envelope.txt_name)}
            className="shrink-0 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-secondary hover:bg-surface-raised"
          >
            Copy
          </button>
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-text-muted">
          TXT record value
        </p>
        <div className="flex items-start justify-between gap-3">
          <code className="break-all font-mono text-xs text-text-primary">
            {envelope.txt_value}
          </code>
          <button
            type="button"
            onClick={() => copyToClipboard(envelope.txt_value)}
            className="shrink-0 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-secondary hover:bg-surface-raised"
          >
            Copy
          </button>
        </div>
      </div>
      <p className="text-xs text-text-muted">
        Expires {new Date(envelope.expires_at).toLocaleString()}. Re-request
        the challenge if propagation took longer than 24 hours.
      </p>
    </div>
  );
}

function errMessage(err: unknown): string {
  if (err instanceof ClaimClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Request failed";
}

// ---------------------------------------------------------------------------
// Section 1: Claim domain wallet
// ---------------------------------------------------------------------------

function ClaimWalletSection() {
  const [domain, setDomain] = useState("");
  const [wallet, setWallet] = useState("");
  const [envelope, setEnvelope] = useState<ChallengeEnvelope | null>(null);
  const [verifyResult, setVerifyResult] = useState<
    | { kind: "ok"; verifiedAt: string }
    | { kind: "error"; message: string }
    | null
  >(null);
  const [status, setStatus] = useState<ClaimStatus | null>(null);
  const [busy, setBusy] = useState<null | "challenge" | "verify" | "status">(null);
  const [topError, setTopError] = useState<string | null>(null);

  async function onChallenge(e: React.FormEvent) {
    e.preventDefault();
    setTopError(null);
    setVerifyResult(null);
    setBusy("challenge");
    try {
      const env = await postChallenge({ domain, wallet });
      setEnvelope(env);
    } catch (err) {
      setTopError(errMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function onVerify() {
    setTopError(null);
    setBusy("verify");
    try {
      const res = await postVerify({ domain, wallet });
      if (res.ok) {
        setVerifyResult({ kind: "ok", verifiedAt: res.verified_at });
      } else {
        setVerifyResult({
          kind: "error",
          message: res.message ?? res.error ?? "verify_failed",
        });
      }
    } catch (err) {
      setVerifyResult({ kind: "error", message: errMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function onCheckStatus() {
    if (!domain) return;
    setTopError(null);
    setBusy("status");
    try {
      const s = await getStatus(domain);
      setStatus(s);
    } catch (err) {
      setTopError(errMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      id="claim"
      className="space-y-5 rounded-2xl border border-border bg-surface p-6"
    >
      <header className="space-y-2">
        <h2 className="text-xl font-medium text-text-primary">
          Claim your domain wallet
        </h2>
        <p className="text-sm text-text-secondary">
          Prove you control the domain with a DNS TXT record. Once verified,
          every paid Unbrowse call against your domain routes a share of the
          settlement to the wallet you bind here.
        </p>
      </header>

      {topError && <ResultBlock tone="error">{topError}</ResultBlock>}

      <form onSubmit={onChallenge} className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-xs uppercase tracking-wide text-text-muted">
            Apex domain
          </span>
          <input
            name="domain"
            type="text"
            inputMode="url"
            placeholder="example.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-text-primary focus:border-orange-500 focus:outline-none"
            required
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs uppercase tracking-wide text-text-muted">
            Solana wallet to bind
          </span>
          <input
            name="wallet"
            type="text"
            placeholder="base58 pubkey, 32 to 44 chars"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-text-primary focus:border-orange-500 focus:outline-none"
            required
          />
        </label>
        <button
          type="submit"
          disabled={busy === "challenge"}
          className="rounded-md bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
        >
          {busy === "challenge" ? "Generating..." : "Get challenge"}
        </button>
      </form>

      {envelope && (
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            Publish this TXT record on your DNS provider, then come back and
            verify.
          </p>
          <TxtRecordReveal envelope={envelope} />
          <button
            type="button"
            onClick={onVerify}
            disabled={busy === "verify"}
            className="rounded-md border border-orange-500 bg-surface px-4 py-2 text-sm font-medium text-orange-600 hover:bg-orange-50 disabled:opacity-50"
          >
            {busy === "verify" ? "Checking DNS..." : "I have published the TXT"}
          </button>
        </div>
      )}

      {verifyResult?.kind === "ok" && (
        <ResultBlock tone="ok">
          Verified at {new Date(verifyResult.verifiedAt).toLocaleString()}. The
          wallet is now bound to {domain}.
        </ResultBlock>
      )}
      {verifyResult?.kind === "error" && (
        <ResultBlock tone="error">
          Could not verify: {verifyResult.message}. DNS often takes a few
          minutes to propagate; try again shortly.
        </ResultBlock>
      )}

      <div className="border-t border-border pt-4 space-y-2">
        <button
          type="button"
          onClick={onCheckStatus}
          disabled={!domain || busy === "status"}
          className="text-xs text-text-secondary underline hover:text-text-primary disabled:opacity-50"
        >
          Check existing binding for this domain
        </button>
        {status && (
          <ResultBlock tone={status.verified ? "ok" : "info"}>
            {status.verified ? (
              <>
                {domain} is already verified
                {status.wallet_address ? (
                  <>
                    {" "}
                    to{" "}
                    <code className="font-mono text-xs">
                      {status.wallet_address}
                    </code>
                  </>
                ) : null}
                .
              </>
            ) : (
              <>No binding found for {domain}.</>
            )}
          </ResultBlock>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section 2: Opt out of the marketplace
// ---------------------------------------------------------------------------

function OptOutSection() {
  const [domain, setDomain] = useState("");
  const [envelope, setEnvelope] = useState<ChallengeEnvelope | null>(null);
  const [verifyResult, setVerifyResult] = useState<
    | { kind: "ok"; disabledCount: number; optedOutAt: string }
    | { kind: "error"; message: string }
    | null
  >(null);
  const [status, setStatus] = useState<TakedownStatus | null>(null);
  const [busy, setBusy] = useState<null | "challenge" | "verify" | "status">(null);
  const [topError, setTopError] = useState<string | null>(null);

  async function onChallenge(e: React.FormEvent) {
    e.preventDefault();
    setTopError(null);
    setVerifyResult(null);
    setBusy("challenge");
    try {
      const env = await postTakedownChallenge({ domain });
      setEnvelope(env);
    } catch (err) {
      setTopError(errMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function onVerify() {
    setTopError(null);
    setBusy("verify");
    try {
      const res = await postTakedownVerify({ domain });
      if (res.ok) {
        setVerifyResult({
          kind: "ok",
          disabledCount: res.disabled_count,
          optedOutAt: res.opted_out_at,
        });
      } else {
        setVerifyResult({
          kind: "error",
          message: res.message ?? res.error ?? "verify_failed",
        });
      }
    } catch (err) {
      setVerifyResult({ kind: "error", message: errMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function onCheckStatus() {
    if (!domain) return;
    setTopError(null);
    setBusy("status");
    try {
      const s = await getTakedownStatus(domain);
      setStatus(s);
    } catch (err) {
      setTopError(errMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      id="opt-out"
      className="space-y-5 border-l-2 border-orange-300 bg-surface-sunken/40 p-6 rounded-r-2xl"
    >
      <header className="space-y-2">
        <h2 className="text-xl font-medium text-text-primary">
          Opt out of the marketplace
        </h2>
        <p className="text-sm text-text-secondary">
          Disable every Unbrowse skill that targets your domain. Same DNS
          proof, different TXT value. Once verified, captured skills flip to
          disabled and the publish pipeline rejects future captures from this
          domain.
        </p>
      </header>

      {topError && <ResultBlock tone="error">{topError}</ResultBlock>}

      <form onSubmit={onChallenge} className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-xs uppercase tracking-wide text-text-muted">
            Apex domain
          </span>
          <input
            name="optout-domain"
            type="text"
            inputMode="url"
            placeholder="example.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-text-primary focus:border-orange-500 focus:outline-none"
            required
          />
        </label>
        <button
          type="submit"
          disabled={busy === "challenge"}
          className="rounded-md border border-border bg-surface px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-raised disabled:opacity-50"
        >
          {busy === "challenge" ? "Generating..." : "Get takedown challenge"}
        </button>
      </form>

      {envelope && (
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            The takedown TXT does not include a wallet; it only proves you
            control the domain. Publish it, then verify.
          </p>
          <TxtRecordReveal envelope={envelope} />
          <button
            type="button"
            onClick={onVerify}
            disabled={busy === "verify"}
            className="rounded-md border border-orange-500 bg-surface px-4 py-2 text-sm font-medium text-orange-600 hover:bg-orange-50 disabled:opacity-50"
          >
            {busy === "verify" ? "Checking DNS..." : "I have published the TXT"}
          </button>
        </div>
      )}

      {verifyResult?.kind === "ok" && (
        <ResultBlock tone="ok">
          Domain disabled at{" "}
          {new Date(verifyResult.optedOutAt).toLocaleString()}.{" "}
          {verifyResult.disabledCount} skill
          {verifyResult.disabledCount === 1 ? "" : "s"} flipped to disabled.
        </ResultBlock>
      )}
      {verifyResult?.kind === "error" && (
        <ResultBlock tone="error">
          Could not verify: {verifyResult.message}.
        </ResultBlock>
      )}

      <div className="border-t border-border pt-4 space-y-2">
        <button
          type="button"
          onClick={onCheckStatus}
          disabled={!domain || busy === "status"}
          className="text-xs text-text-secondary underline hover:text-text-primary disabled:opacity-50"
        >
          Check opt-out status for this domain
        </button>
        {status && (
          <ResultBlock tone={status.opted_out ? "ok" : "info"}>
            {status.opted_out ? (
              <>
                {domain} opted out
                {status.opted_out_at ? (
                  <>
                    {" "}
                    at {new Date(status.opted_out_at).toLocaleString()}
                  </>
                ) : null}
                {typeof status.disabled_count === "number" ? (
                  <>
                    {" "}({status.disabled_count} skill
                    {status.disabled_count === 1 ? "" : "s"} disabled)
                  </>
                ) : null}
                .
              </>
            ) : (
              <>{domain} is still listed.</>
            )}
          </ResultBlock>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section 3: Submit your official API
// ---------------------------------------------------------------------------

function EMPTY_ENDPOINT(): OfficialEndpointInput {
  return { method: "GET", url_template: "", description: "", x402_supported: false };
}

function SubmitOfficialSection() {
  const [domain, setDomain] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [endpoints, setEndpoints] = useState<OfficialEndpointInput[]>([EMPTY_ENDPOINT()]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | { kind: "ok"; submissionId: string; status: string; message?: string }
    | { kind: "error"; message: string }
    | null
  >(null);

  function updateEndpoint(idx: number, patch: Partial<OfficialEndpointInput>) {
    setEndpoints((prev) =>
      prev.map((ep, i) => (i === idx ? { ...ep, ...patch } : ep)),
    );
  }

  function addEndpoint() {
    setEndpoints((prev) => [...prev, EMPTY_ENDPOINT()]);
  }

  function removeEndpoint(idx: number) {
    setEndpoints((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const body = {
        domain,
        contact_email: contactEmail,
        name: name || undefined,
        description: description || undefined,
        endpoints: endpoints.filter((ep) => ep.url_template.trim().length > 0),
      };
      const res = await postSubmitOfficial(body);
      setResult({
        kind: "ok",
        submissionId: res.submission_id,
        status: res.status,
        message: res.message,
      });
    } catch (err) {
      setResult({ kind: "error", message: errMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const mailtoHref = buildOfficialSubmissionMailto(domain);

  return (
    <section
      id="submit-official"
      className="space-y-5 rounded-2xl border border-border bg-surface-raised p-6"
    >
      <header className="space-y-2">
        <h2 className="text-xl font-medium text-text-primary">
          Submit your official API
        </h2>
        <p className="text-sm text-text-secondary">
          If your domain ships canonical endpoints (especially x402-priced
          ones) we will promote them above captured shadow routes in resolve.
          Submit them here, or email the team if you prefer.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-xs uppercase tracking-wide text-text-muted">
              Domain
            </span>
            <input
              name="official-domain"
              type="text"
              inputMode="url"
              placeholder="example.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-text-primary focus:border-orange-500 focus:outline-none"
              required
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs uppercase tracking-wide text-text-muted">
              Contact email
            </span>
            <input
              name="contact-email"
              type="email"
              placeholder="you@example.com"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-orange-500 focus:outline-none"
              required
            />
          </label>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs uppercase tracking-wide text-text-muted">
            Skill name (optional)
          </span>
          <input
            name="skill-name"
            type="text"
            placeholder="Example API"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-orange-500 focus:outline-none"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs uppercase tracking-wide text-text-muted">
            Short description (optional)
          </span>
          <textarea
            name="skill-description"
            rows={3}
            placeholder="What does this API do?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-orange-500 focus:outline-none"
          />
        </label>

        <fieldset className="space-y-3">
          <legend className="text-xs uppercase tracking-wide text-text-muted">
            Endpoints
          </legend>
          {endpoints.map((ep, idx) => (
            <div
              key={idx}
              className="space-y-2 rounded-md border border-border bg-surface p-3"
            >
              <div className="grid grid-cols-1 gap-2 md:grid-cols-[6rem_1fr_auto]">
                <select
                  name={`endpoints[${idx}][method]`}
                  value={ep.method}
                  onChange={(e) => updateEndpoint(idx, { method: e.target.value })}
                  className="rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs text-text-primary"
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="PATCH">PATCH</option>
                  <option value="DELETE">DELETE</option>
                </select>
                <input
                  name={`endpoints[${idx}][url_template]`}
                  type="text"
                  placeholder="https://api.example.com/v1/items/{id}"
                  value={ep.url_template}
                  onChange={(e) =>
                    updateEndpoint(idx, { url_template: e.target.value })
                  }
                  className="rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs text-text-primary focus:border-orange-500 focus:outline-none"
                />
                {endpoints.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeEndpoint(idx)}
                    className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-secondary hover:bg-surface-raised"
                  >
                    Remove
                  </button>
                )}
              </div>
              <input
                name={`endpoints[${idx}][description]`}
                type="text"
                placeholder="What this endpoint does"
                value={ep.description}
                onChange={(e) =>
                  updateEndpoint(idx, { description: e.target.value })
                }
                className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-primary focus:border-orange-500 focus:outline-none"
              />
              <label className="flex items-center gap-2 text-xs text-text-secondary">
                <input
                  name={`endpoints[${idx}][x402_supported]`}
                  type="checkbox"
                  checked={ep.x402_supported}
                  onChange={(e) =>
                    updateEndpoint(idx, { x402_supported: e.target.checked })
                  }
                />
                x402 priced (returns HTTP 402 with a Faremeter accept envelope)
              </label>
            </div>
          ))}
          <button
            type="button"
            onClick={addEndpoint}
            className="text-xs text-orange-600 underline hover:text-orange-700"
          >
            Add another endpoint
          </button>
        </fieldset>

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
          >
            {busy ? "Submitting..." : "Submit for review"}
          </button>
          <a
            href={mailtoHref}
            className="text-sm text-text-secondary underline hover:text-text-primary"
          >
            Or email the team instead
          </a>
        </div>
      </form>

      {result?.kind === "ok" && (
        <ResultBlock tone="ok">
          Received. Submission id{" "}
          <code className="font-mono text-xs">{result.submissionId}</code>,
          status {result.status}.
          {result.message ? <> {result.message}</> : null}
        </ResultBlock>
      )}
      {result?.kind === "error" && (
        <ResultBlock tone="error">
          Could not submit: {result.message}. The email fallback above always
          works.
        </ResultBlock>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

export default function ClaimPage() {
  return (
    <main className="mx-auto min-h-[100dvh] max-w-3xl space-y-12 px-6 py-16">
      <header className="space-y-4">
        <Link
          href="/"
          className="text-xs text-text-muted hover:text-text-secondary"
        >
          ← Home
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight text-text-primary">
          Claim your domain on Unbrowse
        </h1>
        <p className="max-w-[65ch] text-base text-text-secondary">
          Three things you can do here. Bind a wallet to a domain you own and
          earn on every paid call that hits it. Opt the domain out of the
          marketplace entirely. Or send us your canonical APIs so they rank
          above captured shadow routes in resolve.
        </p>
        <nav className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-text-secondary">
          <a href="#claim" className="underline hover:text-text-primary">
            1. Claim a wallet
          </a>
          <a href="#opt-out" className="underline hover:text-text-primary">
            2. Opt out
          </a>
          <a href="#submit-official" className="underline hover:text-text-primary">
            3. Submit official API
          </a>
        </nav>
      </header>

      <ClaimWalletSection />

      <OptOutSection />

      <SubmitOfficialSection />

      <footer className="space-y-2 border-t border-border pt-6 text-xs text-text-muted">
        <p>
          Source-of-truth doc:{" "}
          <a
            href="https://github.com/unbrowse-ai/unbrowse/blob/main/docs/CLAIM_YOUR_DOMAIN.md"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-text-secondary"
          >
            docs/CLAIM_YOUR_DOMAIN.md
          </a>
          . The wallet binding rides on the same Flex settlement described in{" "}
          <Link href="/how-unbrowse-pays" className="underline hover:text-text-secondary">
            how-unbrowse-pays
          </Link>
          .
        </p>
      </footer>
    </main>
  );
}
