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
