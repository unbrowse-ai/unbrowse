/** What one node answer did, as the card under its tool row says it. */
export type Receipt = {
  /** called | network | learned | browse | pages */
  how: string
  /** The site's host, e.g. news.ycombinator.com */
  site: string
  /** The route's id or name; for a network route, its entry id */
  route: string | null
  /** The call's own time, as the node measured it */
  ms: number | null
  /** USDC paid for another contributor's route; null or 0 when nothing was paid */
  paidUsdc: number | null
  /** Whether the node's browser was used */
  browser: boolean
  ok: boolean
  /** webfetch: a WebFetch the plugin answered; tool: Claude's own unbrowse_do or a route tool */
  via: 'webfetch' | 'tool'
  /** Characters of the site's answer Claude read */
  answerChars: number
  /** Characters of the page itself, when measured (savings: measure); null until then or when off */
  pageChars: number | null
}

/** Running totals: this session in state, all time in the plugin's store. */
export type Ledger = {
  calls: number
  browserless: number
  paidUsdc: number
  answerChars: number
  /** Characters of the measured pages, and of the answers that stood for them */
  measuredPageChars: number
  measuredAnswerChars: number
  since: number
}

/** One line of the node's activity log (~/.unbrowse/activity.jsonl), as the pane shows it. */
export type Activity = { at: number; who: string; site: string; what: string; kind: string; result: string; ms: number | null; note: string }

/** The node's local routes, as the band, the prompt section and the route tools read them. */
export type RouteIndex = { count: number; sites: { site: string; whats: string[] }[] }

// ── watches (hooks/watch.ts) ──
export type WatchOp = '>' | '<' | '>=' | '<=' | '==' | '!=' | 'contains'

export type WatchWhen =
  | { kind: 'changed'; path?: string }
  | { kind: 'threshold'; path: string; op: WatchOp; value: string | number }
  | { kind: 'new_items'; path: string; key?: string }

export type WatchThen = 'toast' | 'wake' | 'suggest' | 'agent' | 'phone'

export type Watch = {
  id: string
  routeId: string
  site: string
  what: string
  inputs: Record<string, string>
  everyS: number
  when: WatchWhen
  then: WatchThen[]
  /** What to do when it fires, in the person's words; a woken turn or an agent is given it */
  note: string
  createdAt: number
  lastAt: number | null
  /** What the last check left to compare with: a hash, the condition's last truth, or the keys seen */
  last: string | boolean | string[] | null
  fires: number
  lastError: string | null
}

export type WatchFire = { watchId: string; at: number; what: string; site: string; summary: string }

declare module 'claude-code' {
  interface PluginState {
    unbrowse: {
      receipts: Shaped<Record<string, Receipt>>
      session: Shaped<Ledger>
      allTime: Shaped<Ledger | null>
      activity: Shaped<Activity[]>
      routes: Shaped<RouteIndex | null>
      demand: Shaped<Record<string, number>>
      watches: Shaped<Watch[]>
      fires: Shaped<WatchFire[]>
    }
  }
}
