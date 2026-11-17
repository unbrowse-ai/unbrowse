// npm i unbrowse ai @ai-sdk/openai, then export UNBROWSE_NODE and UNBROWSE_AGENT_TOKEN from the Unbrowse app's agent key.
import { generateText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { unbrowseTools } from "unbrowse/ai-sdk";

// UNBROWSE_STUB_MODEL=1 runs it with a scripted model, calling no model API.
const model = process.env.UNBROWSE_STUB_MODEL ? (await import("./stub.mjs")).model : openai("gpt-5-mini");

const { text } = await generateText({
  model,
  tools: unbrowseTools(),
  stopWhen: stepCountIs(5),
  prompt: "What are the top Hacker News stories about Rust? https://hn.algolia.com/api/v1/search?query=rust answers it.",
});
console.log(text);
