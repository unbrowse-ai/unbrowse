// npm i unbrowse langchain @langchain/core @langchain/openai, then export UNBROWSE_NODE and UNBROWSE_AGENT_TOKEN from
// the Unbrowse app's agent key.
import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { unbrowseTools } from "unbrowse/langchain";

// UNBROWSE_STUB_MODEL=1 runs it with a scripted model, calling no model API.
const model = process.env.UNBROWSE_STUB_MODEL ? (await import("./stub.mjs")).model : new ChatOpenAI({ model: "gpt-5-mini" });

const agent = createAgent({ model, tools: unbrowseTools() });
const { messages } = await agent.invoke({
  messages: [{ role: "user", content: "What are the top Hacker News stories about Rust? https://hn.algolia.com/api/v1/search?query=rust answers it." }],
});
console.log(messages.at(-1).content);
