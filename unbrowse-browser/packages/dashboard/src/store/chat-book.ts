"use client";

import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { createChatBook, dropChat, loadChat, saveChat } from "@/lib/chat-history";
import { getChatApiUrl } from "@/store/chat";

function browserStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * A chat's session is fixed when it is made, so its turns can't follow the view
 * elsewhere. It takes a generated id, not the session's name: `useChat` follows
 * a new chat by its id, and a session's name can start a second chat.
 */
const book = createChatBook((chatId): Chat<UIMessage> => {
  const chat: Chat<UIMessage> = new Chat<UIMessage>({
    transport: new DefaultChatTransport({
      api: getChatApiUrl(),
      body: () => ({ session: chatId }),
    }),
    // Saved here as well as by the panel: no panel is watching a turn that ends
    // while another session or side tab is on screen.
    onFinish: ({ messages }) => saveChatFor(chatId, chat, messages),
  });
  return chat;
});

export const chatFor = book.chatFor;

export function loadChatFor(chatId: string): UIMessage[] {
  return loadChat(browserStore(), chatId) as UIMessage[];
}

export function saveChatFor(chatId: string, chat: Chat<UIMessage>, messages: UIMessage[]): void {
  if (book.isCurrent(chatId, chat)) saveChat(browserStore(), chatId, messages);
}

export function clearChatFor(chatId: string): void {
  dropChat(browserStore(), chatId);
}

/** The session is gone: its chat stops, and its name starts fresh. */
export function forgetChatFor(chatId: string): void {
  book.forget(chatId);
  clearChatFor(chatId);
}
