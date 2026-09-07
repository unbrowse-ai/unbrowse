/* /aiko — Aiko product landing + early-bird waitlist.
 *
 * Aiko is an employee for your Mac: tell her the outcome, she works out the
 * path and brings back the finished result. This page sells the 50%-off
 * early-bird subscription ($200/mo regular, $100/mo for early subscribers) and
 * captures a waitlist email for those not ready to subscribe today.
 *
 * Copy, brand, voice and pricing are sourced from the live aiko-v4-lite site.
 * Dark editorial brand is scoped under .aiko-root (see ./aiko.css) so it does
 * not leak into the orange/white unbrowse shell. */

import type { Metadata } from "next";
import {
  ArrowRight, Check, Eye, KeyRound, Terminal, Sparkles,
  Inbox, Calendar, Globe, CreditCard, ShieldCheck,
} from "lucide-react";
import { AikoWaitlistForm } from "@/components/aiko/waitlist-form";
import { SubscribeButton } from "@/components/aiko/subscribe-button";
import { AIKO_PRICE } from "@/lib/aiko/offer";
import "./aiko.css";

const CANONICAL = "https://www.unbrowse.ai/aiko";

export const metadata: Metadata = {
  title: "Aiko, she already knows how you work",
  description:
    "Aiko lives on your Mac, so your files, mail and calendar are already hers. You never paste your context. She just has it, and does the work. Early subscribers lock in 50% off: $100/month instead of $200.",
  alternates: { canonical: CANONICAL },
  keywords: [
    "Aiko", "AI assistant for Mac", "AI employee", "personal AI assistant",
    "macOS assistant", "early access", "waitlist", "50% off",
  ],
  openGraph: {
    title: "Aiko, she already knows how you work",
    description:
      "Aiko lives on your Mac, so your context is already hers. You never explain yourself. She just does the work. Early subscribers lock in 50% off.",
    url: CANONICAL,
    siteName: "Unbrowse",
    type: "website",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Aiko, she already knows how you work" }],
  },
  twitter: {
    card: "summary_large_image",
    site: "@getFoundry",
    title: "Aiko, she already knows how you work",
    description: "She lives on your Mac, so your context is already hers. Early subscribers lock in 50% off.",
    images: ["/og-image.png"],
  },
};

const PILLARS = [
  { icon: Eye, t: "She has your context", b: "You never paste your files, your calendar, your last ten emails. She lives on your Mac, so it is already hers. She just knows." },
  { icon: Sparkles, t: "She learns how you work", b: "She does not make you teach her. She watches what you actually do, and the thing you repeat every week becomes one sentence." },
  { icon: Check, t: "She does the work", b: "Most AI answers. Aiko does the work. She books it, sends it, buys it, and asks only before the one step that cannot be undone." },
  { icon: ShieldCheck, t: "It stays on your Mac", b: "One app, nothing to set up. She reads your screen on your machine, and your files and emails never leave it." },
];

const HOW = [
  { n: "01", t: "Say the outcome", b: "Tell her what you need in plain words. No setup, no prompts to tune. “Clear my inbox.” “Find me dog leashes on Carousell.”" },
  { n: "02", t: "She works the path", b: "She figures out the steps, reads what is on your screen, moves across your inbox, calendar and files, and reaches the web for you." },
  { n: "03", t: "She brings it back", b: "The finished result, not a list of links. She pauses for your nod only on the one step that cannot be undone: send, pay, book." },
];

const DOES = [
  { icon: Inbox, t: "Clears your inbox", b: "Reads, sorts, drafts and replies across email, so the morning pile is handled before you sit down." },
  { icon: Calendar, t: "Runs your calendar", b: "Finds the time, books it, reschedules the conflict, and tells the people who need to know." },
  { icon: Globe, t: "Reaches the web for you", b: "Researches, compares and pulls what you asked for, without you opening twelve tabs." },
  { icon: Eye, t: "Sees your screen, on-device", b: "She reads what you are already looking at. Your files and emails stay on your Mac." },
  { icon: CreditCard, t: "Pays for the paid stuff", b: "Buys access to the services a job needs, on the spot, so you are never blocked." },
  { icon: Sparkles, t: "Learns what you do twice", b: "Work she has done before becomes a routine she runs on her own, so the second time is one sentence." },
];

const FAQ = [
  { q: "Do I need to be technical?", a: "No. There is no terminal, no keys to copy, no setup wizard. You drag her to Applications, answer three questions, and she is working in about a minute." },
  { q: "Is my data safe?", a: "Aiko reads your screen on-device with a local model. Your files and emails stay on your Mac. She asks before the one irreversible step: sending, paying or booking." },
  { q: "What does the 50% off mean?", a: `Aiko is $${AIKO_PRICE.regularMonthly}/month. Early subscribers lock in $${AIKO_PRICE.earlyBirdMonthly}/month for as long as the subscription stays active. That price is only for the early group.` },
  { q: "What if I am not ready to subscribe?", a: "Join the waitlist with your email and we will hold your early-bird seat. You will be first in line when the next round opens." },
];

// Comparison — ported from the aiko-v4-lite positioning doc. The Aiko column
// is highlighted; the rows are the differentiators against what people have
// already tried.
const COMPARISON = {
  columns: ["ChatGPT / Claude", "Custom GPT", "Zapier / n8n", "Claude Code", "Aiko"],
  rows: [
    { f: "Reaches into your inbox?", v: ["no", "no", "with setup", "with setup", "pre-wired"] },
    { f: "Remembers across sessions?", v: ["no", "partial", "no", "no", "journal"] },
    { f: "Setup time", v: ["0 min", "10 min", "2–6 hours", "hours–days", "30 seconds"] },
    { f: "Needs a terminal?", v: ["no", "no", "no", "yes", "no"] },
    { f: "Runs on-device?", v: ["no", "no", "no", "depends", "yes"] },
    { f: "Improves with use?", v: ["no", "no", "no", "no", "yes"] },
    { f: "Has to be a developer?", v: ["optional", "optional", "optional", "required", "no"] },
  ],
};

// Verifiable receipts — adapted from the aiko-v4-lite "Three things you can
// verify" proof strip. Credibility before the ask; claims are checkable.
const RECEIPTS = [
  { t: "Nothing happens off-screen", b: "Watch what she does, step by step. She works in the open on your machine, not in a black box you have to trust." },
  { t: "Local-first", b: "A 4-bit on-device model in the macOS app sandbox. No data exfiltration, and it still answers with WiFi off." },
  { t: "Open, readable config", b: "Your setup is plain JSON files you can open and read. No proprietary lock-in on your data." },
];

// Access-layer partners — ported from aiko-v4-lite's PaymentAccessStrip. x402 +
// Solana render as inline marks; the rest as logos under /public/partners/.
const PARTNERS = {
  eyebrow: "Access layer",
  heading: "x402-native, no API keys in the way.",
  body:
    "x402 makes paid APIs reachable through normal HTTP. pay.sh approves the spend, Crossmint handles the wallet layer, Unbrowse opens the web task — so Aiko can add the capability she needs without making you create provider accounts or paste secrets.",
  proof: [
    "API-keyless paid access",
    "Wallet-approved requests",
    "Wallet execution through Crossmint",
    "Web execution through Unbrowse",
  ],
  logos: [
    { name: "x402", mark: "x402" },
    { name: "Solana", mark: "solana" },
    { name: "MoonPay", src: "/partners/moonpay.svg" },
    { name: "Unbrowse", src: "/logo.png" },
    { name: "Crossmint", src: "/partners/crossmint.svg" },
    { name: "pay.sh", src: "/partners/paysh-logo.png" },
    { name: "PayAI", src: "/partners/payai-horizontal-lockup.svg" },
    { name: "Uprock", src: "/partners/uprock-logo.png" },
    { name: "NUS FinTech Lab", src: "/partners/nus-fintech-lab-cover.jpg" },
    { name: "Corbits", src: "/partners/corbits-wordmark-orange.svg" },
  ] as ({ name: string; mark: "x402" | "solana" } | { name: string; src: string })[],
};

function PartnerMark({ kind }: { kind: "x402" | "solana" }) {
  if (kind === "solana") {
    return (
      <svg viewBox="0 0 149 22.142" aria-hidden className="aiko-partners__svg" style={{ maxWidth: 96 }}>
        <defs>
          <linearGradient id="aiko-sol" x1="2.494" x2="22.809" y1="22.671" y2="-0.233" gradientUnits="userSpaceOnUse">
            <stop offset="0.08" stopColor="#9945FF" /><stop offset="0.3" stopColor="#8752F3" />
            <stop offset="0.5" stopColor="#5497D5" /><stop offset="0.6" stopColor="#43B4CA" />
            <stop offset="0.72" stopColor="#28E0B9" /><stop offset="0.97" stopColor="#19FB9B" />
          </linearGradient>
        </defs>
        <path d="m25.033 17.458-4.087 4.382a.95.95 0 0 1-.692.302H.879a.476.476 0 0 1-.348-.798l4.082-4.382a.95.95 0 0 1 .692-.302H24.68a.473.473 0 0 1 .353.798m-4.087-8.827a.96.96 0 0 0-.692-.302H.879a.475.475 0 0 0-.348.798l4.082 4.385a.96.96 0 0 0 .692.302H24.68a.476.476 0 0 0 .346-.798zM.879 5.483h19.375a.95.95 0 0 0 .692-.302L25.033.798a.475.475 0 0 0-.09-.724A.47.47 0 0 0 24.68 0H5.305a.95.95 0 0 0-.692.302L.531 4.685a.475.475 0 0 0 .348.798" fill="url(#aiko-sol)" />
        <path d="M48.653 9.365H38.288V5.95h13.06V2.538H38.252a3.407 3.407 0 0 0-3.425 3.388v3.46a3.406 3.406 0 0 0 3.425 3.392h10.38v3.414H35.075v3.413h13.578a3.41 3.41 0 0 0 3.425-3.388v-3.46a3.406 3.406 0 0 0-3.425-3.392m20.08-6.827H58.33a3.407 3.407 0 0 0-3.434 3.388v10.291a3.405 3.405 0 0 0 3.434 3.389h10.405a3.407 3.407 0 0 0 3.425-3.389V5.926a3.4 3.4 0 0 0-2.12-3.136 3.4 3.4 0 0 0-1.305-.252Zm-.025 13.654H58.354V5.952h10.35zm36.468-13.654H95.028a3.407 3.407 0 0 0-3.425 3.388v13.68h3.46v-5.607h10.102v5.607h3.46V5.926a3.41 3.41 0 0 0-2.136-3.143 3.4 3.4 0 0 0-1.313-.246Zm-.025 8.047H95.049V5.951h10.102zm40.424-8.047h-10.149a3.406 3.406 0 0 0-3.425 3.388v13.68h3.46v-5.607h10.079v5.607H149V5.926a3.42 3.42 0 0 0-1.011-2.403 3.4 3.4 0 0 0-2.414-.985m-.035 8.047h-10.102V5.951h10.102zm-20.066 5.607h-1.384l-4.948-12.224a2.27 2.27 0 0 0-2.113-1.43h-3.07a2.27 2.27 0 0 0-2.283 2.26v14.808h3.46V5.95h1.384l4.945 12.225a2.285 2.285 0 0 0 2.122 1.42h3.07a2.27 2.27 0 0 0 2.283-2.26V2.538h-3.466zm-46.8-13.654h-3.46v13.68a3.405 3.405 0 0 0 3.438 3.388H89.03v-3.414H78.675z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 130 49" aria-hidden className="aiko-partners__svg" style={{ maxWidth: 52 }}>
      <path d="M118.324 0.576478C119.014 0.57648 119.674 0.858802 120.15 1.35771L126.665 8.18262C127.114 8.65205 127.364 9.27606 127.364 9.92498V14.0753C127.364 14.7331 127.107 15.365 126.648 15.8362L102.833 40.2826C102.719 40.4004 102.654 40.5585 102.654 40.723V43.688C102.654 44.0365 102.937 44.3189 103.285 44.3189H126.733C127.081 44.3189 127.364 44.6014 127.364 44.9498V48.3146C127.364 48.6631 127.081 48.9455 126.733 48.9455H100.551C99.1568 48.9455 98.0265 47.8156 98.0265 46.4219V39.6113C98.0265 38.9537 98.2834 38.322 98.7424 37.8507L122.557 13.4044C122.672 13.2866 122.736 13.1285 122.736 12.9641V11.0204C122.736 10.8582 122.674 10.7022 122.562 10.5848L117.61 5.39839C117.491 5.27368 117.326 5.20311 117.154 5.20308H107.232C107.065 5.20308 106.904 5.26962 106.786 5.38792L100.787 11.3854C100.54 11.6318 100.141 11.6318 99.8943 11.3854L97.5143 9.00595C97.268 8.75956 97.2682 8.36018 97.5145 8.11381L104.314 1.31561C104.788 0.842371 105.43 0.576499 106.099 0.576478H118.324ZM83.3191 0.576478C87.966 0.576478 91.7333 4.34266 91.7333 8.98849V40.5316L91.7306 40.7489C91.6172 45.2222 88.0106 48.8275 83.5362 48.9409L83.3191 48.9436H72.9752L72.7581 48.9409C68.2837 48.8275 64.6771 45.2222 64.5637 40.7489L64.561 40.5316V8.98849C64.561 4.3427 68.3283 0.57653 72.9752 0.576478H83.3191ZM52.3016 0C52.65 3.30462e-05 52.9327 0.282507 52.9327 0.630901V21.1508C52.9327 21.4992 53.2152 21.7817 53.5638 21.7817H58.0944C58.443 21.7817 58.7255 22.0643 58.7255 22.4126V25.7774C58.7255 26.1258 58.443 26.4083 58.0944 26.4083H53.5638C53.2152 26.4083 52.9327 26.6907 52.9327 27.0392V48.3125C52.9327 48.661 52.6502 48.9434 52.3016 48.9434H48.936C48.5874 48.9434 48.3049 48.661 48.3049 48.3125V27.0392C48.3049 26.6909 48.0222 26.4083 47.6738 26.4083H31.7606C31.5936 26.4083 31.4333 26.342 31.3149 26.224L25.8201 20.745C25.5736 20.4991 25.573 20.1 25.8185 19.8533L45.3973 0.185861C45.5158 0.0669252 45.6769 2.54743e-05 45.8446 0H52.3016ZM2.91808 15.5368C3.0823 15.3729 3.34834 15.3729 3.51257 15.5368L16.8285 28.8242L21.9405 23.7377C22.1048 23.5743 22.3705 23.5743 22.5346 23.7381L25.1542 26.3521C25.3191 26.5166 25.3187 26.7839 25.1535 26.9481L21.3757 30.7036V33.4247L33.3587 45.3822C33.5234 45.5464 33.5234 45.8133 33.3587 45.9776L30.7389 48.5918C30.5746 48.7556 30.3087 48.7556 30.1444 48.5918L16.8285 35.3044L3.51257 48.5918C3.34834 48.7556 3.0823 48.7556 2.91808 48.5918L0.298278 45.9776C0.133648 45.8133 0.133677 45.5464 0.298278 45.3822L12.2812 33.4247V30.7036L0.298278 18.7463C0.133677 18.582 0.13365 18.3152 0.298278 18.1509L2.91808 15.5368Z" fill="currentColor" />
    </svg>
  );
}

export default function AikoLandingPage() {
  // Subscribe starts the LIVE early-bird checkout: a $100/mo subscription charged
  // upfront (via /api/aiko-checkout -> Stripe Checkout Session). That payment is
  // what claims the seat.
  const subscribeLabel = "Subscribe early, 50% off";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Aiko",
    description:
      "Aiko lives on your Mac, so your context is already hers. You never explain yourself; she just does the work.",
    brand: { "@type": "Brand", name: "Aiko" },
    offers: {
      "@type": "Offer",
      price: String(AIKO_PRICE.earlyBirdMonthly),
      priceCurrency: AIKO_PRICE.currency,
      url: CANONICAL,
      availability: "https://schema.org/PreOrder",
      description: `Early-bird 50% off: $${AIKO_PRICE.earlyBirdMonthly}/month (regular $${AIKO_PRICE.regularMonthly}/month).`,
    },
  };

  return (
    <div className="aiko-root">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      {/* Hero */}
      <section className="aiko-section aiko-section--flush aiko-wrap" style={{ paddingTop: "clamp(4.5rem, 10vw, 7.5rem)" }}>
        <span className="aiko-eyebrow">She already has your context</span>
        <h1 className="aiko-h1">
          She already knows how <em>you</em> work.
        </h1>
        <p className="aiko-lede">
          Aiko lives on your Mac, so your files, mail and calendar are already
          hers. You never paste your context. She just has it, and does the work.
        </p>
        <p className="aiko-kicker" style={{ marginTop: "0.85rem", maxWidth: "44ch" }}>
          Every other AI makes you bring the context. Aiko is the context.
        </p>
        <div className="aiko-ctarow">
          <SubscribeButton label={subscribeLabel} />
          <a className="aiko-cta-ghost" href="#waitlist">Not ready? Join the waitlist</a>
        </div>
        <div className="aiko-chips">
          <span className="aiko-chip"><Terminal className="w-3.5 h-3.5" /> No terminal</span>
          <span className="aiko-chip"><KeyRound className="w-3.5 h-3.5" /> No keys to copy</span>
          <span className="aiko-chip"><Eye className="w-3.5 h-3.5" /> Sees your screen</span>
          <span className="aiko-chip"><ShieldCheck className="w-3.5 h-3.5" /> Runs on your Mac</span>
        </div>
      </section>

      {/* The inversion — four pillars */}
      <section className="aiko-section aiko-wrap">
        <span className="aiko-eyebrow">The difference</span>
        <h2 className="aiko-h2" style={{ marginTop: "1.25rem" }}>
          You don&apos;t learn her. She learns you.
        </h2>
        <p className="aiko-kicker" style={{ marginTop: "1.25rem" }}>
          You don&apos;t open Aiko and explain your life. She already lives it with you.
        </p>
        <div className="aiko-grid aiko-grid--2">
          {PILLARS.map((p) => {
            const Icon = p.icon;
            return (
              <div className="aiko-cell" key={p.t}>
                <Icon className="w-5 h-5" style={{ color: "var(--a-accent-warm)" }} />
                <h3 className="aiko-cell__t" style={{ marginTop: "0.75rem" }}>{p.t}</h3>
                <p className="aiko-cell__b">{p.b}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* 9:15am pain */}
      <section className="aiko-section aiko-wrap">
        <span className="aiko-eyebrow">It is 9:15am</span>
        <h2 className="aiko-h2" style={{ marginTop: "1.25rem" }}>
          You open your laptop. 47 new emails, three threads, a calendar conflict.
        </h2>
        <p className="aiko-kicker" style={{ marginTop: "1.25rem" }}>
          It is 9:15am and you have not started your actual job. You would hire a
          person for this if you could justify it. Aiko is that hire, for your Mac.
          Most tools answer. Aiko does the work.
        </p>
      </section>

      {/* How it works */}
      <section className="aiko-section aiko-wrap">
        <span className="aiko-eyebrow">How she works</span>
        <h2 className="aiko-h2" style={{ marginTop: "1.25rem" }}>Hire her. Don&apos;t learn her.</h2>
        <div className="aiko-grid aiko-grid--3">
          {HOW.map((s) => (
            <div className="aiko-cell" key={s.n}>
              <span className="aiko-cell__n">{s.n}</span>
              <h3 className="aiko-cell__t">{s.t}</h3>
              <p className="aiko-cell__b">{s.b}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Notch demo */}
      <section className="aiko-section aiko-wrap">
        <span className="aiko-eyebrow">She lives in your notch</span>
        <h2 className="aiko-h2" style={{ marginTop: "1.25rem" }}>One sentence. She takes it from there.</h2>
        <div className="aiko-notch" aria-hidden="true">
          <div className="aiko-notch__bar">
            <span className="aiko-notch__eye" />
            <span className="aiko-notch__eye" />
          </div>
          <div className="aiko-bubble">find me dog leashes on carousell</div>
          <div className="aiko-notch__input">
            <span>Talk to Aiko, or type&#8230;</span>
            <span className="aiko-notch__send"><ArrowRight className="w-3.5 h-3.5" /></span>
          </div>
        </div>
      </section>

      {/* What she does */}
      <section className="aiko-section aiko-wrap">
        <span className="aiko-eyebrow">One body, across all of it</span>
        <h2 className="aiko-h2" style={{ marginTop: "1.25rem" }}>What she handles</h2>
        <div className="aiko-grid aiko-grid--3">
          {DOES.map((d) => {
            const Icon = d.icon;
            return (
              <div className="aiko-cell" key={d.t}>
                <Icon className="w-5 h-5" style={{ color: "var(--a-accent-warm)" }} />
                <h3 className="aiko-cell__t" style={{ marginTop: "0.75rem" }}>{d.t}</h3>
                <p className="aiko-cell__b">{d.b}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Comparison — what you've already tried */}
      <section className="aiko-section aiko-wrap">
        <span className="aiko-eyebrow">How Aiko differs</span>
        <h2 className="aiko-h2" style={{ marginTop: "1.25rem" }}>Compared to what you&apos;ve already tried.</h2>
        <div className="aiko-cmp">
          <div className="aiko-cmp__table" role="table">
            <div className="aiko-cmp__h" role="columnheader" />
            {COMPARISON.columns.map((c, i) => (
              <div
                key={c}
                role="columnheader"
                className={`aiko-cmp__h${i === COMPARISON.columns.length - 1 ? " aiko-cmp__h--aiko" : ""}`}
              >
                {c}
              </div>
            ))}
            {COMPARISON.rows.map((row) => (
              <div className="aiko-cmp__row" role="row" key={row.f} style={{ display: "contents" }}>
                <div className="aiko-cmp__f" role="rowheader">{row.f}</div>
                {row.v.map((val, i) => (
                  <div
                    key={i}
                    role="cell"
                    className={`aiko-cmp__c${i === row.v.length - 1 ? " aiko-cmp__c--aiko" : ""}`}
                  >
                    {val}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Receipts — three things you can verify */}
      <section className="aiko-section aiko-wrap">
        <span className="aiko-eyebrow">Receipts</span>
        <h2 className="aiko-h2" style={{ marginTop: "1.25rem" }}>Three things you can verify.</h2>
        <div className="aiko-grid aiko-grid--3">
          {RECEIPTS.map((r) => (
            <div className="aiko-cell" key={r.t}>
              <Check className="w-5 h-5" style={{ color: "var(--a-accent-warm)" }} />
              <h3 className="aiko-cell__t" style={{ marginTop: "0.75rem" }}>{r.t}</h3>
              <p className="aiko-cell__b">{r.b}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Access layer — payment/access partners */}
      <section className="aiko-section aiko-wrap">
        <span className="aiko-eyebrow">{PARTNERS.eyebrow}</span>
        <h2 className="aiko-h2" style={{ marginTop: "1.25rem" }}>{PARTNERS.heading}</h2>
        <p className="aiko-lede" style={{ marginTop: "0.75rem", maxWidth: "54ch" }}>{PARTNERS.body}</p>
        <div className="aiko-partners">
          {PARTNERS.logos.map((logo) => (
            <div className="aiko-partners__cell" key={logo.name}>
              {"mark" in logo ? (
                <PartnerMark kind={logo.mark} />
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img className="aiko-partners__img" src={logo.src} alt={logo.name} loading="lazy" decoding="async" />
              )}
              <span className="aiko-partners__name">{logo.name}</span>
            </div>
          ))}
        </div>
        <ul className="aiko-partners__proof">
          {PARTNERS.proof.map((p) => (
            <li key={p}><Check className="w-4 h-4" style={{ color: "var(--a-accent-warm)" }} />{p}</li>
          ))}
        </ul>
      </section>

      {/* Offer band */}
      <section className="aiko-section aiko-wrap" id="pricing">
        <div className="aiko-offer">
          <span className="aiko-eyebrow">Early-bird, while seats last</span>
          <div className="aiko-price">
            <span className="aiko-price__old">${AIKO_PRICE.regularMonthly}</span>
            <span className="aiko-price__new">${AIKO_PRICE.earlyBirdMonthly}</span>
            <span className="aiko-price__per">/month</span>
          </div>
          <div><span className="aiko-save">Save {AIKO_PRICE.discountPct}% for life of subscription</span></div>
          <p className="aiko-kicker" style={{ margin: "1.25rem auto 0", maxWidth: "44ch" }}>
            Aiko is ${AIKO_PRICE.regularMonthly} a month. Subscribe in the early group and you
            lock in ${AIKO_PRICE.earlyBirdMonthly} a month, for as long as you stay. The price
            goes back up when the early seats are gone.
          </p>
          <div className="aiko-ctarow" style={{ justifyContent: "center" }}>
            <SubscribeButton label={subscribeLabel} />
            <a className="aiko-cta-ghost" href="#waitlist">Just keep me posted</a>
          </div>
        </div>
      </section>

      {/* Waitlist */}
      <section className="aiko-section aiko-wrap" id="waitlist">
        <span className="aiko-eyebrow">Hold my seat</span>
        <h2 className="aiko-h2" style={{ marginTop: "1.25rem" }}>Not ready today? Get on the list.</h2>
        <p className="aiko-kicker" style={{ margin: "1.25rem 0 1.75rem" }}>
          Drop your email and we will hold your early-bird seat. You will be first
          in line when the next round of 50% off opens.
        </p>
        <AikoWaitlistForm />
      </section>

      {/* FAQ */}
      <section className="aiko-section aiko-wrap">
        <span className="aiko-eyebrow">Before you ask</span>
        <h2 className="aiko-h2" style={{ marginTop: "1.25rem" }}>Questions</h2>
        <div className="aiko-faq">
          {FAQ.map((f) => (
            <div className="aiko-faq__item" key={f.q}>
              <p className="aiko-faq__q">{f.q}</p>
              <p className="aiko-faq__a">{f.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Statement */}
      <section className="aiko-statement aiko-wrap">
        <p className="aiko-statement__line">Hire her. Don&apos;t learn her.</p>
        <div className="aiko-ctarow" style={{ justifyContent: "center" }}>
          <SubscribeButton label={subscribeLabel} />
          <a className="aiko-cta-ghost" href="#waitlist">Join the waitlist</a>
        </div>
        <p className="aiko-microcopy" style={{ display: "flex", gap: "0.4rem", justifyContent: "center", alignItems: "center" }}>
          <Check className="w-3.5 h-3.5" /> Secure checkout. Cancel anytime.
        </p>
      </section>
    </div>
  );
}
