import Link from "next/link";
import { Chapter } from "@/components/editions";
import { IconDiamondCheck, IconArrow } from "@/components/archival-icons";
import "./chapters.css";

/**
 * Chapter [08] Economics — Wave-2B port of §10 EarnSection onto cream.
 *
 * 60/40 split:
 *   - Left:  body copy + dual CTAs + setup hint
 *   - Right: 5-row receipt strip with diamond-check icons
 *
 * Honesty guardrails (project CLAUDE.md / EarnSection wave-3 fixes):
 *   - chain is Solana via Faremeter Flex (NOT Base L2)
 *   - Crossmint lobster.cash is the payout path
 *   - capture + indexing are FREE; settlement on agent-to-route execute
 *
 * No dark fills in this chapter. Receipt strip is cream-card with ink text.
 */
export function Ch08Economics() {
  return (
    <Chapter
      id="economics"
      number="[08]"
      name="Economics"
      title="The next agent on your route pays you."
      lede="Capture and indexing are free. When the next agent reuses your route, the call settles in USDC on Solana via Faremeter Flex, directly to your wallet."
    >
      <div className="ed-economics-grid">
        {/* ─── Left: body copy + CTAs ─── */}
        <div className="ed-economics-body">
          <p>
            The sponsor tier covers an agent&apos;s first $1 per day, so they
            explore your routes before they spend their own wallet.
          </p>

          <div className="ed-economics-ctas">
            <Link href="/openclaw-earn" className="ed-cta-ink">
              <span>[ Start earning ]</span>
              <IconArrow size={14} />
            </Link>
            <Link href="/how-unbrowse-pays" className="ed-cta-outline">
              <span>Mining quickstart →</span>
            </Link>
          </div>

          <p className="ed-economics-hint">
            <span style={{ color: "var(--ed-ink)" }}>$</span> Set up Crossmint
            lobster.cash during <code>npx unbrowse setup</code> to wire the
            payout address.
          </p>
        </div>

        {/* ─── Right: receipt strip ─── */}
        <aside className="ed-receipt-strip" aria-label="Earning receipt strip">
          <p className="receipt-label">Receipt strip</p>
          <ul>
            <li>
              <IconDiamondCheck size={14} />
              <span>x402 settlement in USDC on Solana via Faremeter Flex.</span>
            </li>
            <li>
              <IconDiamondCheck size={14} />
              <span>
                Capture and indexing are free. You earn when another agent
                reuses your cached route.
              </span>
            </li>
            <li>
              <IconDiamondCheck size={14} />
              <span>
                Sponsor tier: $1/day per agent, $50/day per platform; past
                that, agents fall through to their own wallet.
              </span>
            </li>
            <li>
              <IconDiamondCheck size={14} />
              <span>
                Payouts to bank via Crossmint lobster.cash, set up in one step.
              </span>
            </li>
            <li>
              <IconDiamondCheck size={14} />
              <span>
                Public ledger at <Link href="/leaderboard">/leaderboard</Link>{" "}
                shows real routes, real wallets, real USDC.
              </span>
            </li>
          </ul>
          <p className="ed-receipt-footer">
            Asked for repeatedly on r/AI_Agents, r/SaaS, r/CryptoCurrency,
            r/ethdev. Trace in /docs/POSITIONING.md.
          </p>
        </aside>
      </div>
    </Chapter>
  );
}
