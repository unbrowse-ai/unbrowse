// npm i unbrowse @mastra/core, then export UNBROWSE_NODE and UNBROWSE_AGENT_TOKEN from the Unbrowse app's agent key.
import { Agent } from "@mastra/core/agent";
import { unbrowseTools } from "unbrowse/mastra";

// UNBROWSE_STUB_MODEL=1 runs it with a scripted model, calling no model API.
const model = process.env.UNBROWSE_STUB_MODEL ? (await import("../ai-sdk/stub.mjs")).model : "openai/gpt-5-mini";

const agent = new Agent({
  id: "hn-reader",
  name: "HN reader",
  instructions: "Answer questions about websites with the Unbrowse tools.",
  model,
  tools: unbrowseTools(),
});
const { text } = await agent.generate("What are the top Hacker News stories about Rust? https://hn.algolia.com/api/v1/search?query=rust answers it.", { maxSteps: 5 });
console.log(text);
