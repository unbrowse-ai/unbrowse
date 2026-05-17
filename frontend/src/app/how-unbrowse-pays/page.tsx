import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "How Unbrowse pays — x402 first, API keys optional, indexers earn",
  description:
    "Every Unbrowse call settles on-chain via Faremeter Flex by default. API keys are an optional billing layer for users who want subscription tiers. Indexers earn 50% of revenue from skills they discovered.",
};

export default function HowUnbrowsePays() {
  return (
    <main className="mx-auto max-w-[70ch] px-6 py-16 space-y-10">
      <header className="space-y-3">
        <Link
          href="/"
          className="text-xs text-text-muted hover:text-text-secondary"
        >
          ← Home
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight text-text-primary">
          How Unbrowse pays
        </h1>
        <p className="text-base text-text-secondary">
          x402 settlement on Solana is the default. API keys are optional.
          Indexers earn 50% of every paid call to a skill they discovered.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-xl font-medium text-text-primary">
          x402 is the main path
        </h2>
        <p className="text-sm text-text-secondary">
          Every paid skill on Unbrowse advertises an x402 payment envelope.
          When an agent calls a paid endpoint, the server responds with HTTP
          402 carrying two accept entries: Faremeter Flex (prepaid escrow +
          on-chain splits) and the exact scheme via PayAI&apos;s facilitator.
          The agent signs an authorization with its session key, and
          settlement happens on-chain in USDC. No account, no API key, no
          signup is required to pay.
        </p>
        <p className="text-sm text-text-secondary">
          This works for autonomous agents that run with their own wallet,
          for clients embedded in larger applications, and for one-off calls
          from the command line via{" "}
          <code className="font-mono text-xs text-text-primary">unbrowse fetch</code>{" "}
          or{" "}
          <code className="font-mono text-xs text-text-primary">unbrowse execute</code>.
          The payment layer is part of the wire protocol, not part of an
          account system.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-medium text-text-primary">
          API keys are optional, for subscription billing only
        </h2>
        <p className="text-sm text-text-secondary">
          You only need an Unbrowse API key if you want one of the things
          accounts provide: a subscription tier (Free / Pro / Metered), a
          per-key prepaid credit budget so your agent auto-pays without
          per-call signing, the encrypted cookie vault to sync site logins
          between machines, or per-skill public-private visibility on skills
          you publish. Every one of those is an opt-in revenue surface, not
          a requirement to use Unbrowse.
        </p>
        <p className="text-sm text-text-secondary">
          The Pro tier ($20/mo) grants a monthly credit balance that paid
          skills draw from. The Metered tier bills per execute via Stripe
          Meter API. The Free tier still works; it just pays per-call via
          x402 like any anonymous caller.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-medium text-text-primary">Indexing</h2>
        <p className="text-sm text-text-secondary">
          When you (or your agent) browses a site through Unbrowse, the
          capture pipeline records the API calls the site makes: HAR network
          traffic plus an in-page interceptor that captures fetch / XHR /
          GraphQL requests the HAR misses. On session close, the captured
          traffic flows through enrichment (auth header extraction, semantic
          descriptions via an LLM augmenter, dependency-graph construction)
          and the resulting skill is published to the marketplace.
        </p>
        <p className="text-sm text-text-secondary">
          The first agent to publish a skill for a domain is its indexer.
          The skill carries the indexer&apos;s wallet address in its
          manifest. From then on, every paid call to any endpoint on that
          skill pays the indexer 50% of the price, automatically, on-chain,
          in the same Flex settlement that pays the platform.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-medium text-text-primary">
          Discoverability
        </h2>
        <p className="text-sm text-text-secondary">
          Agents discover skills three ways. The marketplace card list at{" "}
          <Link
            href="/search"
            className="text-text-primary underline hover:text-text-secondary"
          >
            /search
          </Link>{" "}
          is the public catalog; every public skill appears there, searchable
          by intent or domain. The{" "}
          <code className="font-mono text-xs text-text-primary">unbrowse resolve</code>{" "}
          command queries a graph index keyed by domain plus intent
          embedding, so an agent asking &ldquo;search reddit for posts
          about X&rdquo; gets back the right skill even if it doesn&apos;t
          know the skill name. And for cold domains, the first-pass browser
          capture seeds the index automatically; the agent that browses an
          unindexed site becomes its indexer.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-medium text-text-primary">
          Private skills
        </h2>
        <p className="text-sm text-text-secondary">
          Every skill is public by default. From{" "}
          <Link
            href="/account"
            className="text-text-primary underline hover:text-text-secondary"
          >
            /account
          </Link>{" "}
          you can toggle any skill you own to private. A private skill is
          excluded from the marketplace card list, excluded from the resolve
          graph index (other agents&apos;{" "}
          <code className="font-mono text-xs text-text-primary">unbrowse resolve</code>{" "}
          calls will not match it), and the manifest endpoint at{" "}
          <code className="font-mono text-xs text-text-primary">/v1/skills/:id</code>{" "}
          returns 404 to non-owners so the URL space doesn&apos;t leak which
          private skill_ids exist. You still see and execute your own private
          skills via{" "}
          <code className="font-mono text-xs text-text-primary">/v1/account/skills</code>;{" "}
          toggling back to public re-indexes the skill into the resolve graph
          immediately.
        </p>
        <p className="text-sm text-text-secondary">
          Private skills still earn the indexer 50% when the owner executes
          them through the paid path; they&apos;re just hidden from other
          agents.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-medium text-text-primary">
          The 50 / 50 split
        </h2>
        <p className="text-sm text-text-secondary">
          Every Flex payment carries a splits array signed by the paying
          agent. The split is 5000 basis points to the platform recipient
          (Unbrowse) and 5000 basis points proportionally distributed across
          the skill&apos;s contributors, weighted by the{" "}
          <code className="font-mono text-xs text-text-primary">cumulative_delta</code>{" "}
          attribution score each contributor accumulated. The Faremeter
          program caps splits at 5 entries, so a skill with more than 4
          contributors collapses to the top 4 by delta. Duplicate recipients
          (contributor wallet equals platform wallet, two contributor entries
          for the same wallet) are merged before submit.
        </p>
        <p className="text-sm text-text-secondary">
          Settlement is batched on-chain by the Faremeter facilitator;
          agents get sub-second response latency, the on-chain transaction
          confirms in the background, and contributors see USDC land in
          their wallet without writing a line of payout code. The platform
          half funds infrastructure; the contributor half is the data
          moat&apos;s monetary incentive.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-medium text-text-primary">
          Remote cookie jar
        </h2>
        <p className="text-sm text-text-secondary">
          Account holders can opt in to a per-domain encrypted cookie vault.
          Run{" "}
          <code className="font-mono text-xs text-text-primary">unbrowse cookies push reddit.com</code>{" "}
          to harvest your local browser cookies for that domain,
          envelope-encrypt them with your account&apos;s AES-GCM data key,
          and upload the ciphertext. Run{" "}
          <code className="font-mono text-xs text-text-primary">unbrowse cookies pull reddit.com</code>{" "}
          on another machine to retrieve them. The server never holds
          plaintext cookies; the master key is a Worker secret and your
          per-user data key is wrapped under it. Manage the synced domain
          list, individual deletes, and full vault purge from{" "}
          <Link
            href="/account/cookies"
            className="text-text-primary underline hover:text-text-secondary"
          >
            /account/cookies
          </Link>
          .
        </p>
      </section>

      <section className="space-y-3 pt-4 border-t border-border">
        <h2 className="text-xl font-medium text-text-primary">
          Wallets stay with lobster.cash
        </h2>
        <p className="text-sm text-text-secondary">
          Unbrowse does not provision wallets, hold private keys, or sign
          transactions. The wallet layer is{" "}
          <a
            href="https://lobster.cash"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-text-primary"
          >
            lobster.cash
          </a>
          , a delegated signer that owns the secret and broadcasts the
          authorization the x402 envelope asks for. unbrowse owns four
          things on a paid call: the use-case intent, the amount, the
          recipient, and the memo. lobster owns the other four:
          provisioning, signing, broadcast, and on-chain status.
        </p>
        <p className="text-sm text-text-secondary">
          Setup is one command on the machine you run unbrowse from:{" "}
          <code className="font-mono text-xs text-text-primary">npx @crossmint/lobster-cli setup</code>
          . The next authed unbrowse CLI call publishes the wallet
          address to your agent profile so the marketplace can route
          your indexer earnings to it. You can inspect the resolution
          state at any time with{" "}
          <code className="font-mono text-xs text-text-primary">unbrowse wallet</code>{" "}
          and on{" "}
          <Link
            href="/account"
            className="underline hover:text-text-primary"
          >
            /account
          </Link>
          .
        </p>
        <p className="text-sm text-text-secondary">
          The delegation boundary is documented in source at{" "}
          <code className="font-mono text-xs text-text-primary">src/payments/index.ts</code>
          . If you ever want to swap lobster for a different signer, the
          interface is small: produce a wallet address, sign a Flex
          authorization for a given amount and recipient, and respect the
          unbrowse-supplied memo.
        </p>
      </section>

      <section className="space-y-3 pt-4 border-t border-border">
        <h2 className="text-xl font-medium text-text-primary">Summary</h2>
        <ul className="text-sm text-text-secondary list-disc pl-6 space-y-1">
          <li>
            x402 on Solana via Faremeter Flex is the default settlement rail
            for every paid skill.
          </li>
          <li>
            API keys exist for revenue (subscription tiers), not for access
            control. Anonymous agents pay per-call.
          </li>
          <li>
            Indexers earn 50% of every paid call to skills they discovered,
            on-chain, in the same finalize transaction as the platform&apos;s
            50%.
          </li>
          <li>
            Private skills are hidden from the marketplace + the resolve
            graph + the public manifest endpoint, but stay fully usable to
            their owner.
          </li>
          <li>
            Remote cookie jar is opt-in via the CLI; the server holds
            ciphertext only.
          </li>
          <li>
            Wallets stay with lobster.cash. unbrowse owns intent,
            amount, recipient, memo; lobster owns provisioning,
            signing, and broadcast.
          </li>
        </ul>
      </section>
    </main>
  );
}
