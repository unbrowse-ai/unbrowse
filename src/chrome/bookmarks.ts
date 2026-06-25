// chrome.bookmarks.* — stateless shape, backed by KvChain. Strong-preference layer.
//
// Mirrors https://developer.chrome.com/docs/extensions/reference/bookmarks/.
// Bookmarks are a tree (bookmark_bar / other / synced roots, each with
// children that are urls or folders). We model the tree directly: every
// node keyed `bookmark:<id>`; per-folder child-id list keyed
// `bookmark:_children:<id>`; root list keyed `bookmark:_roots`.
//
// bookmarkDomains() is the strong-preference signal the resolve/ranking
// layer reads — eTLD+1 domains the user explicitly saved. Redaction:
// eTLD+1 only; never title, subdomain, path, or query.

import { KvChain } from "./kv-chain.js";
import { getRegistrableDomain } from "../domain.js";

export type NodeType = "bookmark" | "folder";

export interface BookmarkNode {
  id: string;
  parentId?: string;
  index: number;
  url?: string;
  title?: string;
  type: NodeType;
  dateAdded?: number;
  dateGroupModified?: number;
  children?: BookmarkNode[]; // populated on getTree / getSubTree
}

export interface CreateDetails {
  parentId?: string;
  index?: number;
  title?: string;
  url?: string;
  type?: NodeType;
}

export interface BookmarksApi {
  chain: KvChain;
  getTree(): Promise<BookmarkNode[]>;
  getSubTree(id: string): Promise<BookmarkNode | undefined>;
  getChildren(id: string): Promise<BookmarkNode[]>;
  get(ids: string | string[]): Promise<BookmarkNode[]>;
  search(query: string | { url?: string; title?: string }): Promise<BookmarkNode[]>;
  create(details: CreateDetails): Promise<BookmarkNode>;
  move(id: string, dest: { parentId?: string; index?: number }): Promise<BookmarkNode>;
  update(id: string, changes: { title?: string; url?: string }): Promise<BookmarkNode>;
  remove(id: string): Promise<void>;
  removeTree(id: string): Promise<void>;
}

const DEFAULT_ROOTS = ["bookmark_bar", "other", "synced"];

export function openBookmarks(chain: KvChain): BookmarksApi {
  return new KvBookmarks(chain);
}

class KvBookmarks implements BookmarksApi {
  constructor(public chain: KvChain) {}

  private nodeKey(id: string): string {
    return `bookmark:${id}`;
  }
  private childrenKey(id: string): string {
    return `bookmark:_children:${id}`;
  }
  private rootsKey(): string {
    return "bookmark:_roots";
  }
  private counterKey(): string {
    return "bookmark:_counter";
  }

  /** Initialize the three default roots if missing. */
  async ensureRoots(): Promise<void> {
    const roots = (await this.chain.open<string[]>(this.rootsKey())) ?? [];
    if (roots.length > 0) return;
    await this.chain.put(this.rootsKey(), DEFAULT_ROOTS);
    for (const id of DEFAULT_ROOTS) {
      await this.chain.put(this.nodeKey(id), {
        id,
        index: DEFAULT_ROOTS.indexOf(id),
        title: id,
        type: "folder" as NodeType,
        children: [],
      });
    }
  }

  async getTree(): Promise<BookmarkNode[]> {
    await this.ensureRoots();
    const roots = (await this.chain.open<string[]>(this.rootsKey())) ?? [];
    const out: BookmarkNode[] = [];
    for (const id of roots) {
      const node = await this.loadRecursive(id);
      if (node) out.push(node);
    }
    return out;
  }

  async getSubTree(id: string): Promise<BookmarkNode | undefined> {
    return this.loadRecursive(id);
  }

  async getChildren(id: string): Promise<BookmarkNode[]> {
    const childIds = (await this.chain.open<string[]>(this.childrenKey(id))) ?? [];
    const out: BookmarkNode[] = [];
    for (const cid of childIds) {
      const node = await this.chain.open<BookmarkNode>(this.nodeKey(cid));
      if (node) out.push(node);
    }
    return out;
  }

  async get(ids: string | string[]): Promise<BookmarkNode[]> {
    const ks = Array.isArray(ids) ? ids : [ids];
    const out: BookmarkNode[] = [];
    for (const id of ks) {
      const node = await this.chain.open<BookmarkNode>(this.nodeKey(id));
      if (node) out.push(node);
    }
    return out;
  }

  async search(query: string | { url?: string; title?: string }): Promise<BookmarkNode[]> {
    const q = typeof query === "string" ? { title: query } : query;
    const roots = (await this.chain.open<string[]>(this.rootsKey())) ?? [];
    const out: BookmarkNode[] = [];
    const walk = async (id: string) => {
      const node = await this.chain.open<BookmarkNode>(this.nodeKey(id));
      if (!node) return;
      if (node.type === "bookmark") {
        const title = (node.title ?? "").toLowerCase();
        const url = (node.url ?? "").toLowerCase();
        const qTitle = (q.title ?? "").toLowerCase();
        const qUrl = (q.url ?? "").toLowerCase();
        if ((!q.title || title.includes(qTitle)) && (!q.url || url.includes(qUrl))) {
          out.push(node);
        }
      }
      const childIds = (await this.chain.open<string[]>(this.childrenKey(id))) ?? [];
      for (const cid of childIds) await walk(cid);
    };
    for (const id of roots) await walk(id);
    return out;
  }

  async create(details: CreateDetails): Promise<BookmarkNode> {
    await this.ensureRoots();
    const parentId = details.parentId ?? "other";
    const parent = await this.chain.open<BookmarkNode>(this.nodeKey(parentId));
    if (!parent) throw new Error(`chrome.bookmarks.create: parent "${parentId}" does not exist`);

    const id = await this.nextId();
    const siblingIds = (await this.chain.open<string[]>(this.childrenKey(parentId))) ?? [];
    const index = details.index ?? siblingIds.length;
    const node: BookmarkNode = {
      id,
      parentId,
      index,
      title: details.title,
      url: details.url,
      type: details.type ?? (details.url ? "bookmark" : "folder"),
      dateAdded: Date.now(),
    };
    // Insert into parent's children at the right index.
    const newSiblings = [...siblingIds];
    newSiblings.splice(index, 0, id);
    await this.chain.put(this.childrenKey(parentId), newSiblings);
    await this.chain.put(this.nodeKey(id), node);
    return node;
  }

  async move(id: string, dest: { parentId?: string; index?: number }): Promise<BookmarkNode> {
    const node = await this.chain.open<BookmarkNode>(this.nodeKey(id));
    if (!node) throw new Error(`chrome.bookmarks.move: "${id}" not found`);
    const oldParent = node.parentId ?? "other";
    const newParent = dest.parentId ?? oldParent;
    if (oldParent !== newParent) {
      const oldSiblings = (await this.chain.open<string[]>(this.childrenKey(oldParent))) ?? [];
      await this.chain.put(this.childrenKey(oldParent), oldSiblings.filter((cid) => cid !== id));
    }
    const newSiblings = (await this.chain.open<string[]>(this.childrenKey(newParent))) ?? [];
    const filtered = newSiblings.filter((cid) => cid !== id);
    const idx = dest.index ?? filtered.length;
    filtered.splice(idx, 0, id);
    await this.chain.put(this.childrenKey(newParent), filtered);
    const moved: BookmarkNode = { ...node, parentId: newParent, index: idx };
    await this.chain.put(this.nodeKey(id), moved);
    return moved;
  }

  async update(id: string, changes: { title?: string; url?: string }): Promise<BookmarkNode> {
    const node = await this.chain.open<BookmarkNode>(this.nodeKey(id));
    if (!node) throw new Error(`chrome.bookmarks.update: "${id}" not found`);
    const updated: BookmarkNode = {
      ...node,
      title: changes.title ?? node.title,
      url: changes.url ?? node.url,
      dateGroupModified: node.type === "folder" ? Date.now() : undefined,
    };
    await this.chain.put(this.nodeKey(id), updated);
    return updated;
  }

  async remove(id: string): Promise<void> {
    const node = await this.chain.open<BookmarkNode>(this.nodeKey(id));
    if (!node) return;
    if (node.type === "folder") {
      const childIds = (await this.chain.open<string[]>(this.childrenKey(id))) ?? [];
      if (childIds.length > 0) {
        throw new Error(`chrome.bookmarks.remove: cannot remove non-empty folder "${id}" — use removeTree`);
      }
    }
    await this.detachFromParent(id, node);
    await this.chain.del(this.nodeKey(id));
  }

  async removeTree(id: string): Promise<void> {
    const node = await this.chain.open<BookmarkNode>(this.nodeKey(id));
    if (!node) return;
    const childIds = (await this.chain.open<string[]>(this.childrenKey(id))) ?? [];
    for (const cid of childIds) await this.removeTree(cid);
    await this.detachFromParent(id, node);
    await this.chain.del(this.nodeKey(id));
    await this.chain.del(this.childrenKey(id));
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  private async loadRecursive(id: string): Promise<BookmarkNode | undefined> {
    const node = await this.chain.open<BookmarkNode>(this.nodeKey(id));
    if (!node) return undefined;
    const childIds = (await this.chain.open<string[]>(this.childrenKey(id))) ?? [];
    if (node.type === "folder" && childIds.length > 0) {
      const children: BookmarkNode[] = [];
      for (const cid of childIds) {
        const c = await this.loadRecursive(cid);
        if (c) children.push(c);
      }
      return { ...node, children };
    }
    return node;
  }

  private async detachFromParent(id: string, node: BookmarkNode): Promise<void> {
    const parentId = node.parentId ?? "other";
    const siblings = (await this.chain.open<string[]>(this.childrenKey(parentId))) ?? [];
    await this.chain.put(this.childrenKey(parentId), siblings.filter((cid) => cid !== id));
  }

  private async nextId(): Promise<string> {
    const counter = (await this.chain.open<number>(this.counterKey())) ?? 0;
    const next = counter + 1;
    await this.chain.put(this.counterKey(), next);
    return String(next);
  }
}

/**
 * Default-preference signal (STRONG): eTLD+1 domains the user explicitly
 * bookmarked. Returned deduped; never the title, subdomain, path, or query.
 *
 * The resolve/ranking layer weights a candidate domain HIGHER when it's in
 * this list than when it's only in recent history (weak signal).
 */
export async function bookmarkDomains(chain: KvChain): Promise<string[]> {
  const bookmarks = openBookmarks(chain);
  const tree = await bookmarks.getTree();
  const out = new Set<string>();
  const walk = (node: BookmarkNode) => {
    if (node.type === "bookmark" && node.url) {
      let host: string;
      try {
        host = new URL(node.url).hostname;
      } catch {
        host = "";
      }
      if (host) {
        const etld = getRegistrableDomain(host) || host;
        if (etld) out.add(etld);
      }
    }
    for (const c of node.children ?? []) walk(c);
  };
  for (const root of tree) walk(root);
  return [...out];
}

/**
 * Load default preferences: bookmarks (strong) + recent history (weak).
 * Convenience entry-point for the resolve/ranking layer — one call gets
 * both signals, shaped exactly like the existing browser-preferences.ts
 * (eTLD+1 only, redacted_by_construction).
 */
export async function loadDefaultPreferences(
  chain: KvChain,
  opts: { sinceDaysAgo?: number } = {},
): Promise<{
  bookmark_domains: string[];
  recent_domains: string[];
  redacted: true;
}> {
  const { recentDomains } = await import("./history.js");
  const [bookmarks, recent] = await Promise.all([
    bookmarkDomains(chain),
    recentDomains(chain, { sinceDaysAgo: opts.sinceDaysAgo ?? 14, maxResults: 50 }),
  ]);
  return {
    bookmark_domains: bookmarks,
    recent_domains: recent.map((d) => d.etld_plus_one),
    redacted: true,
  };
}
