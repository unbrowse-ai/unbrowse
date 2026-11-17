import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  addMeasured, addTo, answers, cardText, failedRoute, fmtTokens, fmtUsdc, forModel, ledgerSaved, parseActivity,
  parseOutput, persistedPath, promptSection, receiptFrom, routeIndex, routeTools, savedTokens,
} from '../hooks/register'
import type { Ledger } from '../types'

// The test kit runs on a host with timers; its types leave them out.
declare const setTimeout: (fn: () => void, ms: number) => unknown
const settle = () => new Promise<void>(r => setTimeout(r, 20))

// DoResult shapes from unbrowse-node/agent-api.json; sites are fixtures.
const CALLED = {
  how: 'called',
  route: { id: 'hn-search', url: 'https://hn.algolia.com/api/v1/search' },
  result: { ok: true, ms: 84, data: { hits: [{ title: 'Rust 2.0' }] }, error: null, paid_usdc: null, browser: false, fields: { more: ['hits[].points'] } },
}
const NETWORK = { how: 'network', entry: { id: 'net-7' }, result: { ok: true, ms: 120, data: [1], error: null, paid_usdc: 0.002, browser: false } }
const BROWSE = { how: 'browse', site: 'example.com', page: '…', why: 'needs a click', next: 'unbrowse_browse' }
const FAILED = { how: 'called', route: { id: 'r' }, result: { ok: false, ms: 50, data: null, error: 'gone', paid_usdc: null } }
// unbrowse_search '' as the node lists it today, "{session}" key and all
const SEARCH = { routes: [
  { id: 'b468d21e9149c17e', '{session}': 'www.lazada.sg', what: '{session} products', method: 'GET', path: '/tag/?q={q}', write: false,
    inputs: [{ name: 'q', default: 'airpods', secret: false, kind: 'text' }] },
  { id: '77dc8a518575df33', '{session}': 'www.opentable.com', what: '{session} restaurants with availability', method: 'GET', path: '/s', write: false,
    inputs: [{ name: 'term', default: 'sushi', secret: false, kind: 'text' }, { name: 'token', default: 'x', secret: true, kind: 'text' }] },
  { id: 'w1', site: 'example.com', what: 'send a message', method: 'POST', path: '/m', write: true, inputs: [] },
  { id: 'n1', site: 'remote.example', what: 'list things', remote: true, inputs: [] },
] }
const mcpText = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }], isError: false })

test('reads replies the way the node sends them', () => {
  expect(parseOutput(mcpText(CALLED))).toEqual(CALLED)
  expect(parseOutput(mcpText(CALLED).content)).toEqual(CALLED)
  expect(parseOutput(JSON.stringify(BROWSE))).toEqual(BROWSE)
  expect(parseOutput('not json')).toBe(null)
})

test('a reply holding the data answers; a page that needs hands or a failed call does not', () => {
  expect(answers(CALLED)).toBe(true)
  expect(answers(NETWORK)).toBe(true)
  expect(answers(BROWSE)).toBe(false)
  expect(answers(FAILED)).toBe(false)
  expect(failedRoute(FAILED)).toBe(true)
  expect(failedRoute(CALLED)).toBe(false)
})

test('the receipt says how, where, how long, what was paid and the tokens not read', () => {
  const r = receiptFrom(CALLED, 'https://hn.algolia.com/?q=rust', 'webfetch')!
  expect(r.site).toBe('hn.algolia.com')
  expect(r.answerChars).toBe(JSON.stringify(CALLED.result.data).length)
  expect(cardText(r).rest).toBe('hn.algolia.com · hn-search · 84 ms · no browser · free · in place of WebFetch')
  const measured = { ...r, pageChars: 400_000 }
  expect(savedTokens(measured)).toBe(Math.round((400_000 - r.answerChars) / 4))
  expect(cardText(measured).rest).toContain('≈100k tokens not read')
  expect(cardText(receiptFrom(NETWORK, 'https://example.com/x', 'tool')!).rest).toBe('example.com · net-7 · 120 ms · no browser · paid $0.002')
})

test('the ledger adds calls, payments and measured pages', () => {
  const zero: Ledger = { calls: 0, browserless: 0, paidUsdc: 0, answerChars: 0, measuredPageChars: 0, measuredAnswerChars: 0, since: 0 }
  const a = receiptFrom(NETWORK, 'https://example.com/x', 'tool')!
  const b = receiptFrom(BROWSE, null, 'tool')!
  let l = addTo(addTo(zero, a, 5), b, 9)
  expect(l.calls).toBe(2)
  expect(l.browserless).toBe(1)
  expect(l.paidUsdc).toBe(0.002)
  expect(l.since).toBe(5)
  l = addMeasured(l, 80_000, 3)
  expect(ledgerSaved(l)).toBe(Math.round((80_000 - 3) / 4))
  expect(fmtTokens(1_234_567)).toBe('1.2M')
  expect(fmtUsdc(0.0125)).toBe('$0.0125')
  expect(fmtUsdc(1.5)).toBe('$1.5')
})

test('local read routes become tools with their own inputs; writes, remote and secrets stay out', () => {
  const t = routeTools(SEARCH)
  expect(t.map(x => x.name)).toEqual(['route_lazada_sg_search_products', 'route_opentable_com_search_restaurants_with_avai'])
  expect(t[0]?.routeId).toBe('b468d21e9149c17e')
  expect(Object.keys((t[1]?.inputSchema.properties ?? {}) as object)).toEqual(['term'])
  const idx = routeIndex(SEARCH)
  expect(idx.count).toBe(3)
  expect(idx.sites.map(s => s.site)).toContain('www.lazada.sg')
  expect(promptSection(idx)).toContain('- www.lazada.sg: search products')
})

test('a reply saved to a file is found by the path its pointer names', () => {
  const pointer = [{ type: 'text', text: '<persisted-output>Output too large (106.3KB). Full output saved to: /Users/me/.claude/projects/p/s/tool-results/mcp-plugin_unbrowse_unbrowse-unbrowse_search-1-abc.txt\nPreview: ...</persisted-output>' }]
  expect(persistedPath(pointer)).toBe('/Users/me/.claude/projects/p/s/tool-results/mcp-plugin_unbrowse_unbrowse-unbrowse_search-1-abc.txt')
  const quoted = [{ type: 'text', text: "Output saved to '/Users/me/x/tool-results/a-1.txt'. Read it with offset." }]
  expect(persistedPath(quoted)).toBe('/Users/me/x/tool-results/a-1.txt')
  expect(persistedPath(mcpText(CALLED).content)).toBe(null)
})

test('reads the node\'s activity log, skipping a cut line', () => {
  const log = '{"v":1,"at":1,"who":"a","site":"www.lazada.sg","what":"Learned {session} products","kind":"learn","result":"done","ms":null,"note":""}\n{"v":1,"at":2,"who":"a","site":"x","what":"call","kind":"call","result":"failed","ms":273,"note":"n"}\n{"v":1,"at":3,"wh'
  const a = parseActivity(log)
  expect(a.length).toBe(2)
  expect(a[0]?.what).toBe('Learned search products')
  expect(a[1]?.ms).toBe(273)
})

test('Claude reads the site JSON, the route and where to go next', () => {
  const text = forModel(CALLED, 'https://hn.algolia.com/?q=rust', 'find Rust stories')
  expect(text).toContain('route hn-search, 84 ms, no browser')
  expect(text).toContain('"title": "Rust 2.0"')
  expect(text).toContain('hits[].points')
})

// ── through the engine ──
const FETCH = { tool: 'WebFetch', url: 'https://hn.algolia.com/?q=rust', prompt: 'find Rust stories' } as const
const ENGINE = { result: { bytes: 1, code: 200, codeText: 'OK', result: 'engine fetched the page', durationMs: 900, url: FETCH.url } }

function node(on: On, replies: Record<string, unknown>) {
  const asked: { tool: string; args: unknown }[] = []
  const store: Record<string, unknown> = {}
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:unbrowse:unbrowse' } }))
  on('mcp.call', (_, e) => {
    const x = e as unknown as { tool: string; args: unknown }
    asked.push({ tool: x.tool, args: x.args })
    return { value: mcpText(replies[x.tool] ?? { error: 'no' }) }
  })
  on('store.get', (_, e) => ({ value: store[(e as unknown as { key: string }).key] }))
  on('store.set', (_, e) => {
    const x = e as unknown as { key: string; value: unknown }
    store[x.key] = x.value
    return { value: undefined }
  })
  on('http.fetch', () => ({ value: { ok: true, status: 200, text: 'x'.repeat(40_000), headers: {} } }))
  on('clock.now', () => ({ value: 1_000 }))
  on('clock.sleep', () => new Promise(() => undefined))
  on('tool.call', () => ENGINE)
  return { asked, store }
}

test('WebFetch is answered from a route, counted in the ledger, and the page measured', async ($, on) => {
  const { asked, store } = node(on, { unbrowse_do: CALLED })
  const out = await $.tool.call(FETCH)
  expect(JSON.stringify(out)).toContain('Rust 2.0')
  expect(JSON.stringify(out)).not.toContain('engine fetched the page')
  const args = JSON.stringify(asked)
  expect(args).toContain('"browser":"never"')
  expect(args).toContain('"budget_usdc":0')
  await settle()
  const l = store.ledger as Ledger
  expect(l.calls).toBe(1)
  expect(l.measuredPageChars).toBe(40_000)
})

test('WebFetch runs as usual when the node has no route, and the site is counted as wanted', async ($, on) => {
  const { store } = node(on, { unbrowse_do: BROWSE })
  expect(JSON.stringify(await $.tool.call(FETCH))).toContain('engine fetched the page')
  await settle()
  expect(store.demand).toEqual({ 'hn.algolia.com': 1 })
})

test('web_fetch off leaves WebFetch alone', { options: { web_fetch: 'off' } }, async ($, on) => {
  const { asked } = node(on, { unbrowse_do: CALLED })
  expect(JSON.stringify(await $.tool.call(FETCH))).toContain('engine fetched the page')
  expect(asked.length).toBe(0)
})

test('a route tool calls the route by id with its inputs', async ($, on) => {
  const registered: string[] = []
  const { asked } = node(on, { unbrowse_search: SEARCH, unbrowse_call: { ok: true, ms: 90, data: { items: ['ipad'] }, error: null, paid_usdc: null } })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/Users/me\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', () => ({ value: { command: 'unb' } }))
  on('tool.register', (_, e) => {
    registered.push((e as unknown as { name: string }).name)
    return { value: { tool: `mcp__unbrowse__${(e as unknown as { name: string }).name}` } }
  })
  on('clock.every', () => ({ value: undefined }))
  on('fs.stat', () => {
    throw new Error('no activity log here')
  })
  on('session.start', (_, e) => ({ cwd: (e as unknown as { cwd: string }).cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  await settle()
  expect(registered).toContain('route_lazada_sg_search_products')
  const out = await $.tool.call({ tool: 'mcp__unbrowse__route_lazada_sg_search_products', q: 'ipad' } as never)
  expect(JSON.stringify(out)).toContain('ipad')
  const call = asked.find(a => a.tool === 'unbrowse_call')
  expect(JSON.stringify(call?.args)).toBe('{"route_id":"b468d21e9149c17e","inputs":{"q":"ipad"}}')
})

test('a receipt card sits under Claude\'s own unbrowse_do call', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>row</Text>
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'unbrowse', component: 'ToolUse', surface,
      props: {
        tool_use_id: 't1', tool: 'mcp__plugin_unbrowse_unbrowse__unbrowse_do', input: { goal: 'g', url: 'https://example.com/?q=1' },
        isRunning: false, isErrored: false, isInterrupted: false, output: mcpText(NETWORK).content,
      },
    } as never)
    const all = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')
    expect(all).toContain('network')
    expect(all).toContain('paid $0.002')
    await ui.unmount()
  }
})

test('the band shows calls, payments and tokens not read', async ($, on) => {
  const l: Ledger = { calls: 12, browserless: 11, paidUsdc: 0.004, answerChars: 9_000, measuredPageChars: 1_000_000, measuredAnswerChars: 8_000, since: 1 }
  on('state.get', ((_: unknown, e: { key: string }) => {
    if (e.key === 'session') return { value: { value: { shape: 'ledger-1', value: l }, version: 1 } }
    if (e.key === 'routes') return { value: { value: { shape: 'routes-1', value: { count: 286, sites: [] } }, version: 1 } }
    return { value: { value: null, version: 0 } }
  }) as never)
  const ui = await $.ui.mount({
    plugin: 'unbrowse', component: 'AbovePrompt', surface: 'terminal',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 140 },
  } as never)
  const all = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(all).toContain('12 calls')
  expect(all).toContain('11 no browser')
  expect(all).toContain('paid $0.004')
  expect(all).toContain('≈248k tokens not read')
  expect(all).toContain('286 routes')
  await ui.unmount()
})
