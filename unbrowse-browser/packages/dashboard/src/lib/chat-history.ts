/**
 * Where a session's chat lives. A conversation belongs to its session, not to
 * the panel on screen: the panel unmounts when another side tab or session is
 * chosen, while a turn keeps driving the browser. So each session has one chat
 * object for as long as the session does, and it saves itself when a turn ends
 * whether or not anyone is looking at it.
 */

const STORAGE_PREFIX = "dashboard-chat-";
const IMAGE_DATA_URL_RE = /data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function chatStorageKey(chatId: string): string {
  return `${STORAGE_PREFIX}${chatId}`;
}

export function loadChat(store: KeyValueStore | null, chatId: string): unknown[] {
  try {
    const parsed = JSON.parse(store?.getItem(chatStorageKey(chatId)) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Saves without the base64 images, which would fill the store in a few turns. */
export function saveChat(store: KeyValueStore | null, chatId: string, messages: unknown[]): void {
  try {
    const json = JSON.stringify(messages).replace(IMAGE_DATA_URL_RE, "[image stripped]");
    store?.setItem(chatStorageKey(chatId), json);
  } catch {
    // Over quota: the conversation stays in memory for as long as the page does.
  }
}

export function dropChat(store: KeyValueStore | null, chatId: string): void {
  try {
    store?.removeItem(chatStorageKey(chatId));
  } catch {
    // Storage unavailable: there is nothing kept to drop.
  }
}

/** One chat per session, made when first asked for. */
export function createChatBook<C extends { stop: () => unknown }>(make: (chatId: string) => C) {
  const chats = new Map<string, C>();
  return {
    chatFor(chatId: string): C {
      let chat = chats.get(chatId);
      if (!chat) {
        chat = make(chatId);
        chats.set(chatId, chat);
      }
      return chat;
    },
    /** False for a chat forgotten since: a turn ending in it must not save it back. */
    isCurrent(chatId: string, chat: C): boolean {
      return chats.get(chatId) === chat;
    },
    forget(chatId: string): void {
      const chat = chats.get(chatId);
      chats.delete(chatId);
      chat?.stop();
    },
  };
}
