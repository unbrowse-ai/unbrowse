// npm i unbrowse @openai/agents, then export UNBROWSE_NODE and UNBROWSE_AGENT_TOKEN from the Unbrowse app's agent key.
import { Agent, run } from "@openai/agents";
import { unbrowseTools } from "unbrowse/openai-agents";

// UNBROWSE_STUB_MODEL=1 runs it with a scripted model, calling no model API.
const stub = process.env.UNBROWSE_STUB_MODEL ? await import("./stub.mjs") : null;

const agent = new Agent({
  name: "HN reader",
  instructions: "Answer questions about websites with the Unbrowse tools.",
  tools: unbrowseTools(),
  ...(stub && { model: stub.model }),
});
const result = await run(agent, "What are the top Hacker News stories about Rust? https://hn.algolia.com/api/v1/search?query=rust answers it.");
console.log(result.finalOutput);
