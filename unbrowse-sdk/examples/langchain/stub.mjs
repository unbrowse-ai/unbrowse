// A scripted LangChain chat model: the first turn calls unbrowse_do, the next answers from what the node sent back. It
// stands in for a real model so the quickstart runs with no model API.
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { summary } from "../ai-sdk/stub.mjs";

const goal = { goal: "search Hacker News stories", url: "https://hn.algolia.com/api/v1/search?query=rust" };

class Scripted extends BaseChatModel {
  _llmType() {
    return "scripted";
  }
  bindTools() {
    return this;
  }
  async _generate(messages) {
    const result = messages.findLast((m) => m.getType() === "tool");
    let message;
    if (!result) {
      console.error(`[stub model] calling unbrowse_do ${JSON.stringify(goal)}`);
      message = new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "unbrowse_do", args: goal, type: "tool_call" }] });
    } else {
      console.error(`[stub model] the node answered ${String(result.content).slice(0, 300)}...`);
      message = new AIMessage(summary(JSON.parse(result.content)));
    }
    return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] };
  }
}

export const model = new Scripted({});
