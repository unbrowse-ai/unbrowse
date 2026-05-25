import { Chapter } from "@/components/editions";
import "./chapters.css";

/**
 * Chapter [10] Anti-ICP — Wave-2B port of §15 AntiIcpBlock onto cream.
 *
 * Editions colophon: three jobs we explicitly do NOT optimize for.
 * Per /positioning-messaging guardrail: "differentiation requires
 * sacrifice; say who it is not for." Short by design.
 *
 * Cream-card with ink text. Hairline-faint between rows. Serif closer.
 */
export function Ch10AntiIcp() {
  const rows: Array<{ scenario: string; instead: string }> = [
    {
      scenario:
        "UI regression CI suites with selectors and traces",
      instead: "Keep Playwright proper.",
    },
    {
      scenario: "Canvas-heavy apps that need imperative JS in-page",
      instead: "Use an agent framework.",
    },
    {
      scenario: "End-user chat interfaces",
      instead: "Use Claude / ChatGPT.",
    },
  ];

  return (
    <Chapter
      id="anti-icp"
      number="[10]"
      name="Anti-ICP"
      title="Three jobs we do not optimize for."
      lede="Differentiation requires sacrifice. Here's where unbrowse is the wrong tool."
    >
      <div className="ed-anti-icp">
        {rows.map((r) => (
          <div key={r.scenario} className="ed-anti-icp-row">
            <span className="scenario">→ {r.scenario}</span>
            <span className="instead">{r.instead}</span>
          </div>
        ))}
        <p className="closer">
          If you need any of those, unbrowse is the wrong tool. We optimize
          for one job: an agent calling an API behind a website, without the
          browser tax.
        </p>
      </div>
    </Chapter>
  );
}
