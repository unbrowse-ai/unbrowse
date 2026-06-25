// chrome.history.* — stateless shape, backed by KvChain. Default-preference layer.
//
// Mirrors https://developer.chrome.com/docs/extensions/reference/history/.
// Every visit is one record; search/getVisits/addUrl/deleteUrl/deleteRange/
// deleteAll operate over the visit log. The output of search({text: ""})
// is the "default preference" signal the unbrowse resolve/ranking layer
// reads — recent eTLD+1 domains the user visited, weighted by visit_count.
//
// Visits are keyed `history:<url>:<ts>` (one record per visit; same URL
// visited N times = N records). An aggregate index `history:_by_url:<url>`
// tracks all visit timestamps for efficient getVisits(). Recent-domains
// aggregation walks the index and returns eTLD+1 frequencies.

import { KvChain } from "./kv-chain.js";
import { getRegistrableDomain } from "../domain.js";

/** chrome.history.HistoryItem — visit aggregate per URL. */
export interface HistoryItem {
  url: string;
  title?: string;
  lastVisitTime: number;
  visitCount: number;
  typedCount: number;
}

/** chrome.history.VisitItem — one visit. */
export interface VisitItem {
  visitId: string;
  visitTime: number;
  referringVisitId?: string;
  transition?: string;
}

/** chrome.history.search query. */
export interface SearchQuery {
  text: string;
  startTime?: number;
  endTime?: number;
  maxResults?: number;
}

export interface HistoryApi {
  chain: KvChain;
  search(query: SearchQuery): Promise<HistoryItem[]>;
  getVisits(url: string): Promise<VisitItem[]>;
  addUrl(url: string, opts?: { title?: string; transition?: string; visitTime?: number }): Promise<void>;
  deleteUrl(url: string): Promise<void>;
  deleteRange(startTime: number, endTime: number): Promise<void>;
  deleteAll(): Promise<void>;
}

export function openHistory(chain: KvChain): HistoryApi {
  return new KvHistory(chain);
}

class KvHistory implements HistoryApi {
  constructor(public chain: KvChain) {}

  private visitKey(url: string, ts: number): string {
    return `history:${url}:${ts}`;
  }
  private urlIndexKey(url: string): string {
    return `history:_by_url:${url}`;
  }
  private allUrlsKey(): string {
    return "history:_all_urls";
  }

  async search(query: SearchQuery): Promise<HistoryItem[]> {
    const urls = (await this.chain.open<string[]>(this.allUrlsKey())) ?? [];
    const out: HistoryItem[] = [];
    const since = query.startTime ?? 0;
    const until = query.endTime ?? Date.now();
    for (const url of urls) {
      const visits = (await this.chain.open<number[]>(this.urlIndexKey(url))) ?? [];
      const inRange = visits.filter((ts) => ts >= since && ts <= until);
      if (inRange.length === 0) continue;
      const meta = await this.chain.open<{ title?: string; typedCount?: number }>(`history:_meta:${url}`);
      if (query.text && query.text !== "") {
        const title = (meta?.title ?? "").toLowerCase();
        if (!url.toLowerCase().includes(query.text.toLowerCase()) && !title.includes(query.text.toLowerCase())) {
          continue;
        }
      }
      out.push({
        url,
        title: meta?.title,
        lastVisitTime: Math.max(...inRange),
        visitCount: inRange.length,
        typedCount: meta?.typedCount ?? 0,
      });
    }
    out.sort((a, b) => b.lastVisitTime - a.lastVisitTime);
    return out.slice(0, query.maxResults ?? 1000);
  }

  async getVisits(url: string): Promise<VisitItem[]> {
    const visits = (await this.chain.open<number[]>(this.urlIndexKey(url))) ?? [];
    return visits
      .map((ts, i) => ({
        visitId: `${url}#${i}`,
        visitTime: ts,
        transition: "link",
      }))
      .sort((a, b) => b.visitTime - a.visitTime);
  }

  async addUrl(url: string, opts: { title?: string; transition?: string; visitTime?: number } = {}): Promise<void> {
    const ts = opts.visitTime ?? Date.now();
    await this.chain.put(this.visitKey(url, ts), { url, ts, transition: opts.transition ?? "link" });
    const visits = (await this.chain.open<number[]>(this.urlIndexKey(url))) ?? [];
    if (!visits.includes(ts)) await this.chain.put(this.urlIndexKey(url), [...visits, ts]);
    const urls = (await this.chain.open<string[]>(this.allUrlsKey())) ?? [];
    if (!urls.includes(url)) await this.chain.put(this.allUrlsKey(), [...urls, url]);
    if (opts.title !== undefined) {
      await this.chain.put(`history:_meta:${url}`, { title: opts.title, typedCount: 0 });
    }
  }

  async deleteUrl(url: string): Promise<void> {
    const visits = (await this.chain.open<number[]>(this.urlIndexKey(url))) ?? [];
    for (const ts of visits) await this.chain.del(this.visitKey(url, ts));
    await this.chain.del(this.urlIndexKey(url));
    await this.chain.del(`history:_meta:${url}`);
    const urls = (await this.chain.open<string[]>(this.allUrlsKey())) ?? [];
    await this.chain.put(this.allUrlsKey(), urls.filter((u) => u !== url));
  }

  async deleteRange(startTime: number, endTime: number): Promise<void> {
    const urls = (await this.chain.open<string[]>(this.allUrlsKey())) ?? [];
    for (const url of urls) {
      const visits = (await this.chain.open<number[]>(this.urlIndexKey(url))) ?? [];
      const keep = visits.filter((ts) => ts < startTime || ts > endTime);
      const drop = visits.filter((ts) => ts >= startTime && ts <= endTime);
      for (const ts of drop) await this.chain.del(this.visitKey(url, ts));
      if (keep.length === 0) {
        await this.chain.del(this.urlIndexKey(url));
        await this.chain.del(`history:_meta:${url}`);
        await this.chain.put(this.allUrlsKey(), urls.filter((u) => u !== url));
      } else {
        await this.chain.put(this.urlIndexKey(url), keep);
      }
    }
  }

  async deleteAll(): Promise<void> {
    const urls = (await this.chain.open<string[]>(this.allUrlsKey())) ?? [];
    for (const url of urls) await this.deleteUrl(url);
    await this.chain.del(this.allUrlsKey());
  }
}

/**
 * Default-preference signal: eTLD+1 domains the user visited recently,
 * weighted by visit_count. The resolve/ranking layer reads this (weak
 * preference — bookmarks are the strong signal).
 *
 * Redaction: eTLD+1 only — never subdomain, path, query, fragment, or
 * page title. Mirrors the existing src/auth/browser-history.ts invariants
 * lifted to the chrome.history.* shape.
 */
export async function recentDomains(
  chain: KvChain,
  opts: { sinceDaysAgo?: number; maxResults?: number } = {},
): Promise<{ etld_plus_one: string; visit_count: number; last_visit: number }[]> {
  const sinceMs = Date.now() - (opts.sinceDaysAgo ?? 14) * 24 * 60 * 60 * 1000;
  const history = openHistory(chain);
  const items = await history.search({ text: "", startTime: sinceMs, maxResults: opts.maxResults ?? 1000 });
  const agg = new Map<string, { visits: number; last: number }>();
  for (const item of items) {
    let host: string;
    try {
      host = new URL(item.url).hostname;
    } catch {
      continue;
    }
    const etld = getRegistrableDomain(host) || host;
    if (!etld) continue;
    const entry = agg.get(etld) ?? { visits: 0, last: 0 };
    entry.visits += item.visitCount;
    if (item.lastVisitTime > entry.last) entry.last = item.lastVisitTime;
    agg.set(etld, entry);
  }
  return [...agg.entries()]
    .map(([etld_plus_one, e]) => ({ etld_plus_one, visit_count: e.visits, last_visit: e.last }))
    .sort((a, b) => b.visit_count - a.visit_count);
}
