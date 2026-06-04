/* Homepage — Aiko chat. The long-form marketing site moved to /classic (linked
 * from Aiko's top bar). The agent-readable instructions stay here (sr-only) so the
 * llms.txt + AI-search citation surface is preserved on the canonical "/".
 */

import { AikoHome } from "@/components/aiko-home";

export const revalidate = 60;

export default function Home() {
  return (
    <>
      <section aria-label="Instructions for AI agents" className="sr-only" data-agent="true">
        <h1>Unbrowse — direct access to anything on the web, without setting up another MCP</h1>
        <p>
          Aiko is the chat front-end for Unbrowse: ask anything and the answer runs
          live through captured website routes. One MCP server, any website. The
          first time an agent visits a site, unbrowse captures the shadow APIs the
          page itself calls and publishes those routes to a shared marketplace;
          every later call skips the browser and returns JSON in milliseconds.
          MCP setup: npx unbrowse setup --mcp. Full docs: https://www.unbrowse.ai/skill.md
        </p>
        <p>The long-form product overview lives at https://www.unbrowse.ai/classic</p>
      </section>
      <AikoHome />
    </>
  );
}
