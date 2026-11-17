/**
 * What the chat keeps after the server compacted a turn. The server rebuilds
 * the model's context from the messages the browser sends, and holds nothing
 * between turns, so its summary lasts past one turn only if the browser sends
 * it back. The summary travels as a `system` message in the shape the server
 * built for that turn (`handle_chat_request` in cli/src/native/stream/chat.rs).
 */

export interface ChatMessage {
  id: string;
  role: string;
  parts: unknown[];
  metadata?: unknown;
}

const COMPACTION_PREFIX = "compaction-";

/** The message standing in for what was summarized, drawn as a divider. */
export function isCompactionMessage(message: { id: string }): boolean {
  return message.id.startsWith(COMPACTION_PREFIX);
}

/**
 * The conversation after the last reply's compaction, or null when there is
 * nothing to do.
 *
 * `keepLastN` counts messages the browser sent, so it is taken back from the
 * reply: the reply itself came after them. The summary's id comes from the
 * reply it belongs to, which makes this safe to run again on a conversation
 * restored from storage, where the reply still carries its metadata.
 */
export function compactMessages<M extends ChatMessage>(messages: M[]): M[] | null {
  let reply = messages.length - 1;
  while (reply >= 0 && messages[reply].role !== "assistant") reply--;
  if (reply < 0) return null;

  const meta = messages[reply].metadata as
    | { compacted?: boolean; summary?: unknown; keepLastN?: unknown }
    | undefined;
  if (!meta?.compacted || typeof meta.keepLastN !== "number") return null;
  if (typeof meta.summary !== "string" || !meta.summary) return null;

  const id = `${COMPACTION_PREFIX}${messages[reply].id}`;
  if (messages.some((m) => m.id === id)) return null;

  const firstKept = reply - meta.keepLastN;
  if (firstKept <= 0) return null;

  const summary = {
    id,
    role: "system",
    parts: [{ type: "text", text: `[Conversation summary]\n${meta.summary}` }],
  } as unknown as M;
  return [summary, ...messages.slice(firstKept)];
}
