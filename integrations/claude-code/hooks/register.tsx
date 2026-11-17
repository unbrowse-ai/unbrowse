// The Unbrowse plugin's hooks module: the node, native in Claude Code.
//
// - WebFetch goes to the node first (browser "never", budget_usdc 0): the site's JSON when a route answers, else
//   WebFetch as always. Option `web_fetch`.
// - Every node answer (that WebFetch, Claude's own unbrowse_do, a route tool) gets a receipt under its row: how, site,
//   route, the node's ms, browser or not, what was paid, and the tokens Claude did not read: the page's size against
//   the answer's, measured by fetching the page once (option `savings`), at about four characters a token.
// - Running totals, this session and all time, in a band above the prompt and the /unb pane.
// - The node's local routes become tools Claude can call (`route_<site>_<what>`, deferred: Claude finds them with
//   ToolSearch), and a short section of the system prompt names the sites they cover. Option `route_tools`.
// - The /unb pane also shows the node's live activity (its own log) and the sites Claude wanted that had no route.
// - A route that fails is learned afresh in the background when option `heal` is on; a page that needs hands says so.
//
// Every call goes through the plugin's own MCP server (`unbrowse mcp`), which signs it with the agent's token: the
// module never sees or sends the token. The module names no site.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Ledger, Receipt, RouteIndex } from '../types'
import { describeWhen, evaluate, firePrompt, fmtEvery, isDue, parseEvery, parseThen, parseWhen } from './watch'
import type { Watch, WatchFire } from './watch'

const BLUE = '#1F5EFF'
const FIELD = '#7AA2FF'
const PAPER = '#F4F6FB'
const MUTE = '#5B6680'
const GREEN = '#4ADE80'
const AMBER = '#FBBF24'
const SIGNAL = '#22D3EE'

const PLUGIN = 'unbrowse'
const SERVER_KEY = 'unbrowse'
const PANE = 'unb'
const NODE_WAIT_MS = 15_000
const HEAL_WAIT_MS = 300_000
const MAX_CHARS = 60_000
const KEEP_RECEIPTS = 200
const MAX_ROUTE_TOOLS = 150
const ACTIVITY_MS = 5_000
const ACTIVITY_KEEP = 40
const CHARS_PER_TOKEN = 4

const EMPTY: Ledger = { calls: 0, browserless: 0, paidUsdc: 0, answerChars: 0, measuredPageChars: 0, measuredAnswerChars: 0, since: 0 }

const receipts = atom({ plugin: 'unbrowse', key: 'receipts' } as const, {}, { shape: 'receipts-2' })
const sessionLedger = atom({ plugin: 'unbrowse', key: 'session' } as const, EMPTY, { shape: 'ledger-1' })
const allTimeLedger = atom({ plugin: 'unbrowse', key: 'allTime' } as const, null, { shape: 'ledger-1' })
const activityAtom = atom({ plugin: 'unbrowse', key: 'activity' } as const, [], { shape: 'activity-1' })
const routesAtom = atom({ plugin: 'unbrowse', key: 'routes' } as const, null, { shape: 'routes-1' })
const demandAtom = atom({ plugin: 'unbrowse', key: 'demand' } as const, {}, { shape: 'demand-1' })
const watchesAtom = atom({ plugin: 'unbrowse', key: 'watches' } as const, [], { shape: 'watches-1' })
const firesAtom = atom({ plugin: 'unbrowse', key: 'fires' } as const, [], { shape: 'fires-1' })

// ── reading the node (pure, tested) ─────────────────────────────────────
type J = Record<string, unknown>
const obj = (v: unknown): J => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function host(url: string | null | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** An MCP tool's output, as a tool row, a tool call or $.mcp.call hands it over, read as the node's JSON reply. */
export function parseOutput(out: unknown): unknown {
  if (typeof out === 'string') {
    try {
      return JSON.parse(out) as unknown
    } catch {
      return null
    }
  }
  if (Array.isArray(out)) {
    const text = out.map(b => obj(b)).find(b => b.type === 'text')
    return text ? parseOutput(text.text) : null
  }
  const o = obj(out)
  if (Array.isArray(o.content)) return parseOutput(o.content)
  if (typeof o.how === 'string' || typeof o.ok === 'boolean') return o
  if (typeof o.text === 'string') return parseOutput(o.text)
  if (o.result !== undefined) return parseOutput(o.result)
  return null
}

const sizeOf = (v: unknown): number => (v === null || v === undefined ? 0 : JSON.stringify(v).length)

/** The receipt for an unbrowse_do reply (DoResult in unbrowse-node/agent-api.json), or null for anything else. */
export function receiptFrom(reply: unknown, url: string | null, via: Receipt['via']): Receipt | null {
  const r = obj(reply)
  const how = str(r.how)
  if (how === null) return null
  const result = obj(r.result)
  const route = obj(r.route)
  const entry = obj(r.entry)
  const site = host(str(route.url) ?? str(route.page) ?? url) || str(r.site) || siteOf(route) || host(url)
  return {
    how,
    site,
    route: str(route.id) ?? str(route.name) ?? str(entry.id),
    ms: num(result.ms) ?? num(r.ms),
    paidUsdc: num(result.paid_usdc),
    browser: result.browser === true || how === 'browse',
    ok: how === 'browse' ? false : how === 'pages' ? true : result.ok === true,
    via,
    answerChars: how === 'pages' ? sizeOf(r.pages) : sizeOf(result.data),
    pageChars: null,
  }
}

/** A route call's answer (CallResult) read as a reply, so a route tool gets the same receipt. */
export function callAsReply(routeId: string, site: string, call: unknown): unknown {
  return { how: 'called', route: { id: routeId, site }, result: obj(call) }
}

/** Whether a reply holds the site's data, ready to be read in place of the page. */
export function answers(reply: unknown): boolean {
  const r = obj(reply)
  const result = obj(r.result)
  return (r.how === 'called' || r.how === 'network' || r.how === 'learned') && result.ok === true &&
    result.data !== null && result.data !== undefined
}

/** Whether a reply says a route it tried failed: worth learning afresh. */
export function failedRoute(reply: unknown): boolean {
  const r = obj(reply)
  return r.route_failed !== undefined && r.route_failed !== null || (r.how === 'called' && obj(r.result).ok === false)
}

export function tokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN)
}

/** Tokens not read: the page against the answer that stood for it; null until the page is measured. */
export function savedTokens(r: Pick<Receipt, 'pageChars' | 'answerChars'>): number | null {
  return r.pageChars === null ? null : Math.max(0, tokens(r.pageChars - r.answerChars))
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

export function fmtUsdc(n: number): string {
  if (n === 0) return '$0'
  return `$${n.toFixed(n < 1 ? 4 : 2).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`
}

/** What Claude reads as WebFetch's result when the node answered. */
export function forModel(reply: unknown, url: string, goal: string): string {
  const r = obj(reply)
  const result = obj(r.result)
  const rc = receiptFrom(reply, url, 'webfetch')
  let data = JSON.stringify(result.data, null, 1)
  const cut = data.length > MAX_CHARS
  if (cut) data = `${data.slice(0, MAX_CHARS)}\n…`
  const more = obj(result.fields).more
  const lines = [
    `The Unbrowse node answered this from the site's own API (how: ${String(r.how)}${rc?.route ? `, route ${rc.route}` : ''}${rc?.ms !== null && rc?.ms !== undefined ? `, ${rc.ms} ms` : ''}, no browser), not from the page's HTML.`,
    `Goal: ${goal}`,
    `URL: ${url}`,
    '',
    '```json',
    data,
    '```',
  ]
  if (cut) lines.push(`(cut at ${MAX_CHARS} characters)`)
  if (Array.isArray(more) && more.length) {
    lines.push(`Other fields the answer has: ${more.slice(0, 30).map(String).join(', ')}. Ask unbrowse_do with fields to get them.`)
  }
  lines.push('If this is not what the page shows, say so with unbrowse_judge (verdict wrong, the route, the url, why).')
  return lines.join('\n')
}

export function cardText(r: Receipt): { how: string; rest: string } {
  const parts: string[] = []
  if (r.site) parts.push(r.site)
  if (r.route) parts.push(r.route)
  if (r.ms !== null) parts.push(`${r.ms} ms`)
  parts.push(r.browser ? 'browser' : 'no browser')
  parts.push(r.paidUsdc ? `paid ${fmtUsdc(r.paidUsdc)}` : 'free')
  const saved = savedTokens(r)
  if (saved !== null) parts.push(`≈${fmtTokens(saved)} tokens not read`)
  if (r.via === 'webfetch') parts.push('in place of WebFetch')
  return { how: r.how, rest: parts.join(' · ') }
}

/** Adds one receipt to a ledger; `measured` adds a page measured afterwards. */
export function addTo(l: Ledger, r: Receipt, now: number): Ledger {
  return {
    calls: l.calls + 1,
    browserless: l.browserless + (r.browser ? 0 : 1),
    paidUsdc: l.paidUsdc + (r.paidUsdc ?? 0),
    answerChars: l.answerChars + r.answerChars,
    measuredPageChars: l.measuredPageChars + (r.pageChars ?? 0),
    measuredAnswerChars: l.measuredAnswerChars + (r.pageChars !== null ? r.answerChars : 0),
    since: l.since || now,
  }
}

export function addMeasured(l: Ledger, pageChars: number, answerChars: number): Ledger {
  return { ...l, measuredPageChars: l.measuredPageChars + pageChars, measuredAnswerChars: l.measuredAnswerChars + answerChars }
}

export function ledgerSaved(l: Ledger): number {
  return Math.max(0, tokens(l.measuredPageChars - l.measuredAnswerChars))
}

// The node lists a route's site under the key "{session}" and writes "{session}" in place of the word "search" in
// its name (seen 2026-11-17, a template leaking into the listing): read both spellings until the listing is fixed.
export function siteOf(route: J): string {
  return str(route.site) ?? str(route['{session}']) ?? ''
}
export function whatOf(route: J): string {
  return (str(route.what) ?? '').replace(/\{session\}/g, 'search')
}

export function routeIndex(reply: unknown): RouteIndex {
  const routes = arr(obj(reply).routes).map(obj).filter(r => r.remote !== true)
  const bySite = new Map<string, string[]>()
  for (const r of routes) {
    const site = siteOf(r)
    if (!site) continue
    const list = bySite.get(site) ?? []
    const what = whatOf(r)
    if (what && !list.includes(what)) list.push(what)
    bySite.set(site, list)
  }
  const sites = [...bySite.entries()].map(([site, whats]) => ({ site, whats })).sort((a, b) => b.whats.length - a.whats.length)
  return { count: routes.length, sites }
}

const slug = (s: string, n: number) => s.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, n)

export type RouteTool = { name: string; routeId: string; site: string; what: string; description: string; inputSchema: J }

/** One tool per local read route: a name the model can tell apart, the route's own inputs as its schema. */
export function routeTools(reply: unknown, max = MAX_ROUTE_TOOLS): RouteTool[] {
  const out: RouteTool[] = []
  const seen = new Set<string>()
  for (const r of arr(obj(reply).routes).map(obj)) {
    if (out.length >= max) break
    const id = str(r.id)
    const site = siteOf(r)
    if (id === null || !site || r.remote === true || r.write === true) continue
    const what = whatOf(r) || 'call'
    let name = `route_${slug(site, 24)}_${slug(what, 28)}`
    if (seen.has(name)) name = `${name.slice(0, 56)}_${id.slice(0, 6)}`
    seen.add(name)
    const props: J = {}
    for (const i of arr(r.inputs).map(obj)) {
      const n = str(i.name)
      if (n === null || i.secret === true) continue
      const d = str(i.default)
      props[n] = { type: 'string', description: d !== null ? `e.g. ${d}` : n }
    }
    out.push({
      name,
      routeId: id,
      site,
      what,
      description: `${what} on ${site}: the site's own API call, learned by the Unbrowse node, answered as JSON with no browser in about a second. Every input is optional; one left out takes the value the route was learned with.`,
      inputSchema: { type: 'object', properties: props, additionalProperties: false },
    })
  }
  return out
}

export function promptSection(index: RouteIndex, max = 60): string {
  const lines = index.sites.slice(0, max).map(s => `- ${s.site}: ${s.whats.slice(0, 4).join('; ')}${s.whats.length > 4 ? `; +${s.whats.length - 4}` : ''}`)
  const more = index.sites.length > max ? `\n- and ${index.sites.length - max} more sites` : ''
  return `# Unbrowse routes on this machine\n\nThe Unbrowse node here has ${index.count} learned routes: each site's own API, called with no browser. For these sites use a route tool (route_<site>_<what>, found with ToolSearch) or unbrowse_do before WebFetch or a browser:\n${lines.join('\n')}${more}`
}

export function parseActivity(text: string): Activity[] {
  const out: Activity[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const o = obj(JSON.parse(line))
      out.push({
        at: num(o.at) ?? 0,
        who: str(o.who) ?? '',
        site: str(o.site) ?? '',
        what: (str(o.what) ?? '').replace(/\{session\}/g, 'search'),
        kind: str(o.kind) ?? '',
        result: str(o.result) ?? '',
        ms: num(o.ms),
        note: str(o.note) ?? '',
      })
    } catch {
      // a line cut by the read window
    }
  }
  return out
}

export function topDemand(d: Record<string, number>, n = 8): [string, number][] {
  return Object.entries(d).sort((a, b) => b[1] - a[1]).slice(0, n)
}

export function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`
}

// ── the node ────────────────────────────────────────────────────────────
let server: string | null = null
let home = ''
let activityAt = -1
const tools = new Map<string, RouteTool>()
const pages = new Map<string, number>()
const routeById = new Map<string, { site: string; what: string }>()

async function nodeServer($: EngineInterface): Promise<string | null> {
  if (server !== null) return server
  const c = await $.mcp.connect(SERVER_KEY).catch(() => null)
  if (c !== null && c.isConnected) server = c.server
  return server
}

async function callNode($: EngineInterface, tool: string, args: J, waitMs: number): Promise<unknown> {
  const name = await nodeServer($)
  if (name === null) return null
  const call = $.mcp.call(name, tool, args).then(r => (r.isError === true ? null : readReply($, r.content)))
  const late = $.clock.sleep(waitMs).then(() => null)
  return Promise.race([call, late]).catch(() => null)
}

/** A reply too large to hand over inline is saved to a file and the text names it: read it from there. */
export function persistedPath(content: unknown): string | null {
  const text = arr(content).map(obj).find(b => b.type === 'text')?.text
  if (typeof text !== 'string' || text.trimStart().startsWith('{')) return null
  return /(\/[^\s"'<>]+\/tool-results\/[^\s"'<>]+?\.(?:txt|json))/.exec(text)?.[1] ?? null
}

async function readReply($: EngineInterface, content: unknown): Promise<unknown> {
  const direct = parseOutput(content)
  if (direct !== null) return direct
  const path = persistedPath(content)
  if (path === null) return null
  const text = await $.fs.read(path).catch(() => null)
  return typeof text === 'string' ? parseOutput(text) : null
}

async function storeGet<T>($: EngineInterface, key: string, fallback: T): Promise<T> {
  const v = await $.store.get(key).catch(() => undefined)
  return v === undefined || v === null ? fallback : (v as T)
}

async function storeSet($: EngineInterface, key: string, value: unknown): Promise<void> {
  await $.store.set(key, value).catch(() => undefined)
}

async function record($: EngineInterface, id: string, r: Receipt, url: string | null, savings: boolean): Promise<void> {
  const now = await $.clock.now()
  await update($, receipts, m => {
    const next = { ...m, [id]: r }
    const ids = Object.keys(next)
    for (const old of ids.slice(0, Math.max(0, ids.length - KEEP_RECEIPTS))) delete next[old]
    return next
  })
  await update($, sessionLedger, l => addTo(l, r, now))
  const all = addTo(await storeGet($, 'ledger', EMPTY), r, now)
  await storeSet($, 'ledger', all)
  await update($, allTimeLedger, () => all)
  if (savings && url !== null && /^https?:/.test(url) && r.answerChars > 0) void measure($, id, url, r.answerChars)
}

async function measure($: EngineInterface, id: string, url: string, answerChars: number): Promise<void> {
  let chars = pages.get(url)
  if (chars === undefined) {
    const res = await $.http.fetch(url).catch(() => null)
    if (res === null || !res.ok) return
    chars = res.text.length
    pages.set(url, chars)
  }
  const pageChars = chars
  await update($, receipts, m => (m[id] ? { ...m, [id]: { ...m[id], pageChars } } : m))
  await update($, sessionLedger, l => addMeasured(l, pageChars, answerChars))
  const all = addMeasured(await storeGet($, 'ledger', EMPTY), pageChars, answerChars)
  await storeSet($, 'ledger', all)
  await update($, allTimeLedger, () => all)
}

async function wanted($: EngineInterface, url: string): Promise<void> {
  const site = host(url)
  if (!site) return
  const d = { ...(await storeGet<Record<string, number>>($, 'demand', {})) }
  d[site] = (d[site] ?? 0) + 1
  await storeSet($, 'demand', d)
  await update($, demandAtom, () => d)
}

async function heal($: EngineInterface, goal: string, url: string): Promise<void> {
  $.ui.toast(`unbrowse: learning ${host(url)} afresh`)
  const reply = await callNode($, 'unbrowse_do', { goal, url, browser: 'auto', budget_usdc: 0 }, HEAL_WAIT_MS)
  $.ui.toast(answers(reply) ? `unbrowse: ${host(url)} works again` : `unbrowse: ${host(url)} still fails; ask unbrowse_do yourself`)
}

async function afterReply($: EngineInterface, reply: unknown, id: string, url: string | null, goal: string | null, via: Receipt['via'], o: Opts): Promise<void> {
  const r = receiptFrom(reply, url, via)
  if (r === null) return
  await record($, id, r, url, o.savings)
  const rr = obj(reply)
  if (rr.how === 'browse') $.ui.toast(`unbrowse: ${r.site || 'the page'} needs hands: ${clip(str(rr.why) ?? 'clicks or typing', 80)}`)
  if (o.heal && failedRoute(reply) && url !== null && goal !== null) void heal($, goal, url)
  if (r.ok && r.route !== null) await offerWatch($, r.route, r.site)
}

// The same route asked twice in a session is something the person is keeping an eye on: offer to watch it, once,
// as a prompt in the box they can send or ignore.
const askedRoutes = new Map<string, number>()
const offered = new Set<string>()

export function watchOffer(what: string, site: string): string {
  return `Watch ${what} on ${site} for me and tell me when it changes`
}

async function offerWatch($: EngineInterface, routeId: string, site: string): Promise<void> {
  const n = (askedRoutes.get(routeId) ?? 0) + 1
  askedRoutes.set(routeId, n)
  if (n < 2 || offered.has(routeId)) return
  offered.add(routeId)
  const watching = await storeGet<Watch[]>($, 'watches', [])
  if (watching.some(w => w.routeId === routeId)) return
  const what = routeById.get(routeId)?.what || routeId
  await $.prompt.suggest({ text: watchOffer(what, site || routeById.get(routeId)?.site || 'its site') }).catch(() => undefined)
}

export const WATCH_GUIDE = `# Unbrowse watches

You can watch a site with the watch tool: the Unbrowse node replays one of its routes on a timer and the watch fires when the answer changes, crosses a value or gains list items, then toasts, starts a turn here, suggests a prompt, starts a background agent or messages the person's phone. Offer one when the person asks to be told when something changes, waits on a price, stock, listing, release, status or reply, or keeps checking the same page. Say in one line what it would watch, how often and what it would do, and set it once they say yes. Don't set one unasked.`

async function loadRoutes($: EngineInterface, withTools: boolean): Promise<void> {
  const reply = await callNode($, 'unbrowse_search', { query: '' }, 30_000)
  if (reply === null) return
  await update($, routesAtom, () => routeIndex(reply))
  for (const r of arr(obj(reply).routes).map(obj)) {
    const id = str(r.id)
    if (id !== null) routeById.set(id, { site: siteOf(r), what: whatOf(r) })
  }
  if (!withTools) return
  for (const t of routeTools(reply)) {
    const done = await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema, isDeferred: true }).catch(() => null)
    if (done !== null) tools.set(`mcp__${PLUGIN}__${t.name}`, t)
  }
}

async function pollActivity($: EngineInterface): Promise<void> {
  if (!home) return
  const path = `${home}/.unbrowse/activity.jsonl`
  const st = await $.fs.stat(path).catch(() => null)
  if (st === null) return
  const size = st.size
  if (size === activityAt) return
  const from = activityAt < 0 || size < activityAt ? Math.max(0, size - 32_768) : activityAt
  const text = await $.fs.read(path, { offset: from, length: size - from }).catch(() => null)
  activityAt = size
  if (typeof text !== 'string') return
  const fresh = parseActivity(text)
  if (fresh.length) await update($, activityAtom, list => [...list, ...fresh].slice(-ACTIVITY_KEEP))
}

async function serveRoute($: EngineInterface, t: RouteTool, input: J, id: string, o: Opts): Promise<string> {
  const inputs: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) if (typeof v === 'string' || typeof v === 'number') inputs[k] = String(v)
  const call = await callNode($, 'unbrowse_call', { route_id: t.routeId, inputs }, 120_000)
  if (call === null) return `The Unbrowse node did not answer route ${t.routeId} (${t.what} on ${t.site}). Try unbrowse_do with a url on ${t.site}.`
  await afterReply($, callAsReply(t.routeId, t.site, call), id, null, null, 'tool', o)
  return JSON.stringify(call, null, 1).slice(0, MAX_CHARS)
}

type Opts = { intercept: boolean; savings: boolean; heal: boolean; routeTools: boolean }

// ── watches: a webhook for any site ─────────────────────────────────────
// Stored in the plugin's store, so every session sees the same watches; one open session checks them at a time
// (a lease it renews each tick), and they wait while no session is open.
const LEASE_MS = 90_000
const TICK_MS = 30_000
const KEEP_FIRES = 30
const HUB_SERVERS = ['deck-daemon-hub-mcp', 'daemon-hub-mcp', 'daemon-hub', 'jarvis-daemon-hub-mcp']
let me = ''
let ticking = false

async function holdLease($: EngineInterface): Promise<boolean> {
  const now = await $.clock.now()
  const lease = await storeGet<{ id: string; at: number } | null>($, 'watch-lease', null)
  if (lease !== null && lease.id !== me && now - lease.at < LEASE_MS) return false
  await storeSet($, 'watch-lease', { id: me, at: now })
  return true
}

async function saveWatches($: EngineInterface, list: Watch[]): Promise<void> {
  await storeSet($, 'watches', list)
  await update($, watchesAtom, () => list)
}

async function callRoute($: EngineInterface, routeId: string, inputs: Record<string, string>): Promise<J> {
  return obj(await callNode($, 'unbrowse_call', { route_id: routeId, inputs }, 60_000))
}

async function watchTick($: EngineInterface): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const list = await storeGet<Watch[]>($, 'watches', [])
    await update($, watchesAtom, () => list)
    const fired = await storeGet<WatchFire[]>($, 'watch-fires', [])
    await update($, firesAtom, () => fired)
    if (list.length === 0 || !(await holdLease($))) return
    const now = await $.clock.now()
    const checked = new Map<string, Watch>()
    for (const w of list) {
      if (!isDue(w, now)) continue
      const c = await callRoute($, w.routeId, w.inputs)
      if (c.ok !== true) {
        checked.set(w.id, { ...w, lastAt: now, lastError: str(c.error) ?? 'the node did not answer' })
        continue
      }
      const v = evaluate(w, c.data)
      const done: Watch = { ...w, lastAt: now, last: v.next, lastError: null, fires: w.fires + (v.fired ? 1 : 0) }
      checked.set(w.id, done)
      if (v.fired) await fire($, done, v.summary, now)
    }
    if (checked.size) {
      // a watch added or removed while this tick ran stays as stored
      const stored = await storeGet<Watch[]>($, 'watches', [])
      await saveWatches($, stored.map(s => checked.get(s.id) ?? s))
    }
  } finally {
    ticking = false
  }
}

async function fire($: EngineInterface, w: Watch, summary: string, now: number): Promise<void> {
  const fires = [...(await storeGet<WatchFire[]>($, 'watch-fires', [])), { watchId: w.id, at: now, what: w.what, site: w.site, summary }].slice(-KEEP_FIRES)
  await storeSet($, 'watch-fires', fires)
  await update($, firesAtom, () => fires)
  const text = firePrompt(w, summary)
  for (const t of w.then) {
    if (t === 'toast') $.ui.toast(`unbrowse watch · ${w.what}: ${clip(summary, 90)}`)
    else if (t === 'wake') void $.prompt.submit({ text }).catch(() => undefined)
    else if (t === 'suggest') void $.prompt.suggest({ text }).catch(() => undefined)
    else if (t === 'agent') void $.agent.spawn({ prompt: text, description: `watch: ${clip(w.what, 30)}`, subagentType: 'general-purpose' }).catch(() => undefined)
    else if (t === 'phone') void phone($, `Unbrowse watch: ${w.what} on ${w.site}. ${summary}`)
  }
}

async function phone($: EngineInterface, text: string): Promise<void> {
  for (const s of HUB_SERVERS) {
    const r = await $.mcp.call(s, 'notify_send', { args: { text, title: 'Unbrowse watch' } }).catch(() => null)
    if (r !== null && r.isError !== true) return
  }
  $.ui.toast('unbrowse watch: no daemon hub connected to send the phone message')
}

async function addWatch($: EngineInterface, input: J): Promise<string> {
  let routeId = str(input.route_id) ?? str(input.route)
  if (routeId !== null) {
    const t = tools.get(routeId) ?? tools.get(`mcp__${PLUGIN}__${routeId}`)
    if (t !== undefined) routeId = t.routeId
  }
  const url = str(input.url)
  if (routeId === null && url !== null) {
    const reply = obj(await callNode($, 'unbrowse_do', { goal: str(input.goal) ?? 'read this page', url, browser: 'auto', budget_usdc: 0 }, 300_000))
    routeId = str(obj(reply.route).id)
    if (routeId === null) return `The node could not make a route for ${url} (${str(reply.how) ?? 'no answer'}), so there is nothing to watch yet. Try unbrowse_do on it first.`
  }
  if (routeId === null) return 'Give route_id (a route id, or a route_<site>_<what> tool name), or url and goal for the node to learn.'
  const when = parseWhen(input.when ?? { kind: 'changed' })
  if (typeof when === 'string') return `when: ${when}`
  const inputs: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj(input.inputs))) if (typeof v === 'string' || typeof v === 'number') inputs[k] = String(v)
  const meta = routeById.get(routeId)
  const now = await $.clock.now()
  const w: Watch = {
    id: `w${Math.floor(now).toString(36)}`,
    routeId,
    site: meta?.site ?? (host(url) || 'the site'),
    what: str(input.name) ?? meta?.what ?? routeId,
    inputs,
    everyS: parseEvery(input.every),
    when,
    then: parseThen(input.then),
    note: str(input.note) ?? '',
    createdAt: now,
    lastAt: null,
    last: null,
    fires: 0,
    lastError: null,
  }
  const c = await callRoute($, routeId, inputs)
  if (c.ok !== true) return `The route didn't answer (${str(c.error) ?? 'no answer'}), so the watch was not set.`
  const v = evaluate(w, c.data)
  const set: Watch = { ...w, lastAt: now, last: v.next }
  await saveWatches($, [...(await storeGet<Watch[]>($, 'watches', [])), set])
  return `Watching ${set.what} on ${set.site} every ${fmtEvery(set.everyS)}: it fires when ${describeWhen(when)}, then ${set.then.join(', ')}. Watch id ${set.id}. Now: ${v.summary}. It checks while a Claude Code session is open.`
}

async function removeWatch($: EngineInterface, id: string): Promise<string> {
  const list = await storeGet<Watch[]>($, 'watches', [])
  const left = list.filter(w => w.id !== id)
  if (left.length === list.length) return `No watch ${id}. The watches tool lists them.`
  await saveWatches($, left)
  return `Stopped watch ${id}.`
}

async function listWatches($: EngineInterface): Promise<string> {
  const list = await storeGet<Watch[]>($, 'watches', [])
  if (list.length === 0) return 'No watches. Set one with the watch tool.'
  return list.map(w => `${w.id}: ${w.what} on ${w.site}, every ${fmtEvery(w.everyS)}, when ${describeWhen(w.when)}, then ${w.then.join(', ')}; fired ${w.fires}×${w.lastError ? `; last check failed: ${w.lastError}` : ''}${w.note ? `; note: ${w.note}` : ''}`).join('\n')
}

const WATCH_TOOLS = [
  {
    name: 'watch',
    description: `Watch a site through the Unbrowse node: a webhook for any site, even one that offers none. The node replays one of its routes (the site's own API, no browser) on a timer and the watch fires when the answer changes the way you say. when: {"kind":"changed","path"?} (anything, or the value at path, changed), {"kind":"threshold","path","op":">|<|>=|<=|==|!=|contains","value"} (fires when it becomes true), or {"kind":"new_items","path","key"?} (the list at path gained items; key names the field that tells items apart). Paths read the route's data: "hits", "items[0].price", "stats.downloads". then (any of): toast (the default), wake (starts a Claude turn here with note), suggest (puts a prompt in the box), agent (a background agent does note), phone (a message through the daemon hub). note is what to do when it fires, in the person's words. Give route_id (an id from unbrowse_search, or a route_<site>_<what> tool name) with its inputs, or a url and goal for the node to learn first. every: "5m" (the default), "30s" is raised to a minute, "2h". The first check is the baseline and never fires. Watches run while a Claude Code session is open.`,
    inputSchema: {
      type: 'object',
      properties: {
        route_id: { type: 'string' },
        inputs: { type: 'object', additionalProperties: { type: 'string' } },
        url: { type: 'string' },
        goal: { type: 'string' },
        name: { type: 'string', description: 'A few words for the watch; the route\'s name otherwise' },
        every: { type: 'string' },
        when: { type: 'object' },
        then: { type: 'array', items: { type: 'string', enum: ['toast', 'wake', 'suggest', 'agent', 'phone'] } },
        note: { type: 'string' },
      },
    },
  },
  { name: 'unwatch', description: 'Stop an Unbrowse watch by its id (the watches tool lists them).', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'watches', description: 'List the Unbrowse watches: what each watches, how often, when it fires, what it then does, and how often it has fired.', inputSchema: { type: 'object', properties: {} } },
]

// ── wiring ──────────────────────────────────────────────────────────────
export const register: Register = (on, options) => {
  const o: Opts = {
    intercept: options.web_fetch !== 'off',
    savings: options.savings !== 'off',
    heal: options.heal === 'on',
    routeTools: options.route_tools !== 'off',
  }

  on('session.start', async ($, e, next) => {
    const h = await $.process.run(['printenv', 'HOME']).catch(() => null)
    home = h?.stdout.trim() ?? ''
    await $.command.register({ name: 'unb', description: 'Unbrowse: calls, payments and tokens saved, routes, live node activity, sites wanted' })
    const all = await storeGet<Ledger | null>($, 'ledger', null)
    const demand = await storeGet<Record<string, number>>($, 'demand', {})
    await update($, allTimeLedger, () => all)
    await update($, demandAtom, () => demand)
    void loadRoutes($, o.routeTools)
    me = await $.session.id().catch(() => String(Math.random()))
    for (const t of WATCH_TOOLS) await $.tool.register(t).catch(() => null)
    const watching = await storeGet<Watch[]>($, 'watches', [])
    await update($, watchesAtom, () => watching)
    if (e.isInteractive) {
      void pollActivity($)
      $.clock.every(ACTIVITY_MS, () => void pollActivity($))
      void watchTick($)
      $.clock.every(TICK_MS, () => void watchTick($))
    }
    return next(e)
  })

  on('command.run', { command: 'unb' }, async $ => {
    await $.ui.open({ id: PANE, title: 'unbrowse' })
    return { text: 'unbrowse pane open' }
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    const index = await read($, routesAtom)
    const added = [{ id: `${PLUGIN}:watches`, text: WATCH_GUIDE, scope: 'session' as const }]
    if (index !== null && index.count > 0) added.unshift({ id: `${PLUGIN}:routes`, text: promptSection(index), scope: 'session' as const })
    return { ...out, sections: [...out.sections, ...added] }
  }).catch(($, e, next) => next(e))

  if (o.intercept) {
    on('tool.call', { tool: 'WebFetch' }, async ($, e, next) => {
      if (e.offset !== undefined && e.offset > 0) return next(e)
      const started = await $.clock.now()
      const reply = await callNode($, 'unbrowse_do', { goal: e.prompt, url: e.url, browser: 'never', budget_usdc: 0 }, NODE_WAIT_MS)
      if (!answers(reply)) {
        void wanted($, e.url)
        if (reply !== null) await afterReply($, reply, e.tool_use_id, e.url, e.prompt, 'webfetch', o)
        return next(e)
      }
      await afterReply($, reply, e.tool_use_id, e.url, e.prompt, 'webfetch', o)
      const text = forModel(reply, e.url, e.prompt)
      return {
        result: { bytes: text.length, code: 200, codeText: 'OK', result: text, durationMs: Math.round((await $.clock.now()) - started), url: e.url },
      }
    }).catch(($, e, next) => next(e))
  }

  // Claude's own node calls, and the route tools
  on('tool.call', async ($, e, next) => {
    const t = tools.get(e.tool)
    if (t !== undefined) {
      const { tool: _t, tool_use_id: _id, agentId: _a, ...input } = e as unknown as J
      return { result: await serveRoute($, t, input, e.tool_use_id, o) }
    }
    if (e.tool === `mcp__${PLUGIN}__watch` || e.tool === `mcp__${PLUGIN}__unwatch` || e.tool === `mcp__${PLUGIN}__watches`) {
      const { tool: _t, tool_use_id: _id, agentId: _a, ...input } = e as unknown as J
      const which = e.tool.slice(`mcp__${PLUGIN}__`.length)
      const text = which === 'watch' ? await addWatch($, input) : which === 'unwatch' ? await removeWatch($, str(input.id) ?? '') : await listWatches($)
      return { result: text }
    }
    if (!/(^|__)unbrowse_do$/.test(e.tool)) return next(e)
    const ran = await next(e)
    const input = obj(e as unknown)
    const reply = parseOutput((ran as { result?: unknown; text?: unknown }).result ?? (ran as { text?: unknown }).text)
    await afterReply($, reply, e.tool_use_id, str(input.url), str(input.goal), 'tool', o).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))

  // ── receipt under the row ──
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const isNode = e.props.tool === 'WebFetch' || /(^|__)unbrowse_do$/.test(e.props.tool) || tools.has(e.props.tool)
    if (!isNode) return next(e)
    let r: Receipt | null = (await read($, receipts))[e.props.tool_use_id] ?? null
    if (r === null && e.props.tool !== 'WebFetch' && !e.props.isRunning && e.props.output !== undefined) {
      r = receiptFrom(parseOutput(e.props.output), str(obj(e.props.input).url), 'tool')
    }
    if (r === null) return next(e)
    const row = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const c = cardText(r)
    return (
      <Box flexDirection="column">
        {row}
        <Box>
          <Text color={BLUE}>  ▌ </Text>
          <Text color={FIELD} bold>unbrowse</Text>
          <Text color={r.ok ? GREEN : AMBER}> {c.how}</Text>
          <Text color={MUTE}> · {c.rest}</Text>
        </Box>
      </Box>
    )
  })

  // ── band ──
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, sessionLedger)
    const index = await read($, routesAtom)
    const watching = await read($, watchesAtom)
    const lastFire = (await read($, firesAtom)).at(-1)
    if (e.props.hasSurvey || (s.calls === 0 && index === null && watching.length === 0)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const saved = ledgerSaved(s)
    const recent = lastFire !== undefined && (await $.clock.now()) - lastFire.at < 15 * 60_000 ? lastFire : undefined
    return (
      <Box>
        <Text color={BLUE}>▌ </Text>
        <Text color={FIELD} bold>unb</Text>
        <Text color={MUTE}> · {s.calls} call{s.calls === 1 ? '' : 's'}</Text>
        {s.calls > 0 ? <Text color={GREEN}> · {s.browserless} no browser</Text> : null}
        <Text color={MUTE}> · paid {fmtUsdc(s.paidUsdc)}</Text>
        {saved > 0 ? <Text color={SIGNAL}> · ≈{fmtTokens(saved)} tokens not read</Text> : null}
        {index !== null ? <Text color={MUTE}> · {index.count} routes</Text> : null}
        {watching.length > 0 ? <Text color={FIELD}> · {watching.length} watching</Text> : null}
        {recent !== undefined ? <Text color={AMBER} bold> · fired: {clip(recent.what, 30)}</Text> : null}
      </Box>
    )
  })

  // ── /unb pane ──
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const w = Math.max(30, e.props.bodyColumns)
    const s = await read($, sessionLedger)
    const all = await read($, allTimeLedger)
    const index = await read($, routesAtom)
    const live = await read($, activityAtom)
    const demand = topDemand(await read($, demandAtom))
    const watching = await read($, watchesAtom)
    const fires = await read($, firesAtom)
    const nowMs = await $.clock.now()
    const ago = (at: number | null) => (at === null ? 'not yet' : `${Math.max(0, Math.round((nowMs - at) / 60_000))}m ago`)
    const kicker = (label: string, extra?: string) => (
      <Box>
        <Text color={BLUE}>■ </Text>
        <Text color={MUTE} bold>{label}</Text>
        {extra !== undefined ? <Text color={MUTE}>  {extra}</Text> : null}
      </Box>
    )
    const row = (label: string, l: Ledger | null) => (
      <Text color={PAPER}>
        {label.padEnd(9)}
        <Text color={MUTE}>{l === null ? '—' : `${l.calls} calls · ${l.browserless} no browser · paid ${fmtUsdc(l.paidUsdc)} · ≈${fmtTokens(ledgerSaved(l))} tokens not read`}</Text>
      </Text>
    )
    return (
      <Box flexDirection="column">
        {kicker('LEDGER', 'tokens ≈ characters ÷ 4, page against answer')}
        {row('session', s)}
        {row('all time', all)}
        <Text> </Text>
        {kicker('WATCHES', watching.length === 0 ? 'ask Claude to watch a site' : `${watching.length} · checked while a session is open`)}
        {watching.map(x => (
          <Box flexDirection="column">
            <Text color={x.lastError ? AMBER : PAPER}>
              ◉ {clip(`${x.what} · ${x.site}`, w - 30)} <Text color={MUTE}>every {fmtEvery(x.everyS)} · {ago(x.lastAt)} · fired {x.fires}×</Text>
            </Text>
            <Text color={MUTE}>    when {clip(describeWhen(x.when), w - 30)} → {x.then.join(', ')}{x.lastError ? ` · ${clip(x.lastError, 40)}` : ''}</Text>
          </Box>
        ))}
        {fires.slice(-5).reverse().map(f => (
          <Text color={AMBER}>⚡ <Text color={MUTE}>{clip(`${ago(f.at)} · ${f.what}: ${f.summary}`, w - 2)}</Text></Text>
        ))}
        <Text> </Text>
        {kicker('ROUTES', index === null ? 'not read yet' : `${index.count} on this node · ${index.sites.length} sites`)}
        {(index?.sites ?? []).slice(0, 8).map(x => (
          <Text color={MUTE}>{clip(`${x.site}: ${x.whats.slice(0, 3).join('; ')}`, w)}</Text>
        ))}
        <Text> </Text>
        {kicker('LIVE', 'the node\'s own log, every agent')}
        {live.length === 0 ? <Text color={MUTE}>nothing yet</Text> : null}
        {live.slice(-12).reverse().map(a => (
          <Text color={a.result === 'done' || a.result === 'ok' ? GREEN : a.result === 'failed' ? AMBER : MUTE}>
            {a.kind === 'learn' ? '◆' : '●'} <Text color={MUTE}>{clip(`${a.site} · ${a.what}${a.ms !== null ? ` · ${a.ms} ms` : ''}${a.result !== 'done' ? ` · ${a.result}` : ''}`, w - 2)}</Text>
          </Text>
        ))}
        <Text> </Text>
        {kicker('WANTED', 'sites Claude fetched that had no route')}
        {demand.length === 0 ? <Text color={MUTE}>none yet</Text> : null}
        {demand.map(([site, n]) => <Text color={AMBER}>{site} <Text color={MUTE}>×{n}</Text></Text>)}
      </Box>
    )
  })
}
