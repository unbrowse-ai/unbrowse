/**
 * Unbrowse-internal contract-shape registry — single source of truth for
 * unifying unbrowse's MCP tools + CLI subcommands. This is an INTERNAL
 * design pattern of the unbrowse package, NOT a claim that unbrowse is
 * the /contract substrate. Per contract 1ef6667f (separation of concerns):
 * unbrowse is a primitive with its own distribution (npm install -g
 * unbrowse, mcp__unbrowse__*, @unbrowse/sdk, GitHub presence); /contract
 * is a separate substrate that COMPOSES unbrowse along with lobster,
 * pay.sh, agentcash, etc., into recursive neuron DAGs.
 *
 * Contracts referenced (citations, not identity):
 *   - 1ef6667f (separation of concerns — this file is unbrowse-internal)
 *   - f5836e77 (unbrowse-internal MCP+CLI unification via shared registry)
 *   - 982a2296 (private-by-design — locality attribute per neuron)
 *   - 72065f2b (only routing/discovery is paid; execute is free + local)
 *   - b5245716 (DAG historical request-sequences for fast-path resolve)
 *   - 18d1a651..75dd360f (stateless-kuri layers 1-6)
 *
 * Every entry maps 1:1 to:
 *   (a) MCP tool registered in src/mcp.ts (caller sees mcp__unbrowse__${name})
 *   (b) Binary subcommand at `unbrowse ${name}` (or `bun src/cli.ts ${name}`)
 *
 * Both transports accept identical JSON I/O. The MCP transport reads args
 * from JSONRPC params, the binary transport reads from stdin / argv. The
 * shape is the SAME because adding a primitive here surfaces it
 * everywhere inside unbrowse.
 *
 * Composability with /contract: a `/contract` declaration can name any of
 * these neuron specs by `name`, and the /contract substrate calls into
 * `unbrowse <name>` via its standard adapter contract. unbrowse does not
 * import /contract code; /contract does not import unbrowse code.
 */

export type Locality = "local-only" | "server-routed" | "either";

export interface ContractNeuronSpec {
  /** Stable kebab-case neuron name; used as MCP tool name + binary subcommand. */
  readonly name: string;

  /** One-line description (agent-readable; ships in MCP toolDescription). */
  readonly description: string;

  /** Contract row id from ~/.contracts/contracts.jsonl declaring this neuron. */
  readonly contract_id: string;

  /** Where does this neuron run? */
  readonly locality: Locality;

  /** Is this a paid neuron? Default false (execution is free). Routing/
   *  discovery neurons are paid because they walk the marketplace DAG. */
  readonly paid?: boolean;

  /** JSON-shape of stdin / MCP params (the inputs). */
  readonly input_shape: string;

  /** JSON-shape of stdout / MCP result (the pointer-shaped output). */
  readonly output_shape: string;

  /** Composition: which other neurons does this one call internally? */
  readonly composes?: readonly string[];
}

/**
 * The canonical registry. Every entry maps 1:1 to a binary subcommand AND
 * an MCP tool. Adding a row here MUST be paired with the implementation
 * file (src/contract-shape/impl/<name>.ts) and the test smoke-roundtrip.
 */
export const CONTRACT_REGISTRY: readonly ContractNeuronSpec[] = [
  {
    name: "contract-fetch",
    description: "Stateless TLS fetch (Layer 1). Single ephemeral subprocess per call. No connection pool. Returns body + capability_pointer.",
    contract_id: "18d1a651",
    locality: "local-only",
    input_shape: "{url: string, intent?: string, ja3_profile?: 'chrome131'|'chrome120'|'firefox120', proxy_url?: string, timeout_ms?: number}",
    output_shape: "{ok: boolean, status: number, body: string, bytes: number, final_url: string, source: 'stateless-fetch', capability_pointer: {transport, ja3_hash, alpn, ephemeral_subprocess_id}, ts: string, pointer_id: string, duration_ms: number, proxy_used: boolean}",
  },
  {
    name: "http-request",
    description: "Stateless HTTP request envelope (Layer 2). Composes layer 1. Carries cookie_jar_pointer by reference (layer 6).",
    contract_id: "f9ffafc4",
    locality: "local-only",
    input_shape: "{method: 'GET'|'POST'|'PUT'|'DELETE'|'PATCH'|'HEAD', url: string, headers?: Record<string,string>, body?: string, redirect_policy?: 'follow'|'manual'|'error', timeout_ms?: number, cookie_jar_pointer?: string}",
    output_shape: "{status: number, headers: Record<string,string>, body: string, bytes: number, redirect_chain: string[], final_url: string, timing: {total_ms, tls_handshake_ms, time_to_first_byte_ms}, via_tls_capability: TlsCapabilityPointer}",
    composes: ["contract-fetch"],
  },
  {
    name: "chrome-runtime",
    description: "Spawn ephemeral chrome runtime (Layer 3). Fresh user-data-dir + ephemeral CDP port per call. NOT IMPLEMENTED — scaffold only.",
    contract_id: "0af18e9f",
    locality: "local-only",
    input_shape: "{chrome_binary_path?: string, stealth_ext_path?: string, navigator_spoof_profile?: NavigatorSpoofProfile, headless?: 'new'|false}",
    output_shape: "{pid: number, cdp_port: number, user_data_dir: string, stealth_ext_sha256: string, navigator_spoof_profile: NavigatorSpoofProfile, ready_at_iso: string, ephemeral: true}",
  },
  {
    name: "page-op",
    description: "Page control via CDP (Layer 4). nav / eval / screenshot / intercept against an ephemeral chrome runtime. NOT IMPLEMENTED — scaffold only.",
    contract_id: "c9d8f459",
    locality: "local-only",
    input_shape: "{runtime_pointer: ChromeRuntimePointer, op: {kind: 'nav'|'eval'|'screenshot'|'intercept', ...}}",
    output_shape: "{op_kind, success: boolean, result_ref: string, duration_ms: number}",
    composes: ["chrome-runtime"],
  },
  {
    name: "capture",
    description: "HAR + fetch/XHR + websocket + perf capture (Layer 5). Attaches to an ephemeral chrome runtime; emits a frozen pointer on teardown. NOT IMPLEMENTED — scaffold only.",
    contract_id: "bbe92ca2",
    locality: "local-only",
    input_shape: "{runtime_pointer: ChromeRuntimePointer, policy: {record_har, record_fetch_xhr, record_websocket, record_perf}}",
    output_shape: "{session_id, chrome_runtime, policy, trace_path: string, frozen: boolean}",
    composes: ["chrome-runtime"],
  },
  {
    name: "auth-jar",
    description: "Resolve cookie jar from local browser profiles (Layer 6). Chrome / Firefox / Dia SQLite + password-manager bridges (Keychain, 1Password, Bitwarden). Returns pointer with metadata only; never raw credentials.",
    contract_id: "75dd360f",
    locality: "local-only",
    input_shape: "{target_host: string, browser_profile_hints?: BrowserProfileHint[]}",
    output_shape: "{cookie_jar: {host, profile_source, fresh, expires_min_utc, cookie_count, resolve_token} | null, next_step: 'ok'|'no_fresh_cookie'|'profile_locked'|'auth_required'}",
  },
  {
    name: "x402-pay",
    description: "Sign an x402 payment invoice via lobster.cash / pay.sh / agentcash.dev / Faremeter Flex. Locality varies by wallet provider; default user wallet = local-only, sponsor middleware = server-routed.",
    contract_id: "beb77c5c",
    locality: "either",
    paid: true,
    input_shape: "{invoice_url: string, terms: PaymentTerms, wallet_provider?: 'lobster'|'paysh'|'agentcash'|'flex'|'sponsor'}",
    output_shape: "{signed_payment_header: string, payment_recipient: string, amount_uc: number, faremeter_toll_uc?: number, ledger_row_id: string}",
  },
  {
    name: "resolve",
    description: "Resolve intent + URL to a DAG-walk sequence of endpoints with success_rate per step (b5245716). Paid: routing/discovery fee.",
    contract_id: "b5245716",
    locality: "server-routed",
    paid: true,
    input_shape: "{intent: string, url?: string, context?: Record<string, unknown>, top_k?: number}",
    output_shape: "{dag_walk: [{endpoint_id, url_template, required_params, expected_yields, success_probability, step_n}], shortlist_for_judgment: [...], next_action?: {title, command, why}}",
  },
  {
    name: "channel-send",
    description: "Send a message via email / chat channel (Gmail / IMAP / AgentMail / Resend / WhatsApp / Telegram / Discord / Slack / SMS). Sessions stay local per privacy-by-design.",
    contract_id: "edc1c467",
    locality: "local-only",
    input_shape: "{channel: 'gmail'|'imap'|'agentmail'|'resend'|'whatsapp'|'telegram'|'discord'|'slack'|'sms', envelope: {to, subject?, body_text, body_html?, attachments?}, identity_pointer?: string}",
    output_shape: "{message_id: string, sent_at_iso: string, channel: string, recipient_hash: string}",
  },
  {
    name: "channel-receive",
    description: "Receive a message from an email/chat channel (poll or watch). Returns message envelope when one arrives matching filters within timeout.",
    contract_id: "edc1c467",
    locality: "local-only",
    input_shape: "{channel: string, filter: {from?, subject_contains?, body_contains?}, timeout_ms?: number}",
    output_shape: "{message: {from, to, subject, body_text, body_html, received_at} | null, source_pointer: string}",
  },
] as const;

/**
 * Lookup helpers — both MCP server and binary subcommand dispatcher use
 * these to route a verb name to its spec.
 */

export function byName(name: string): ContractNeuronSpec | undefined {
  return CONTRACT_REGISTRY.find((s) => s.name === name);
}

export function byContractId(id: string): readonly ContractNeuronSpec[] {
  return CONTRACT_REGISTRY.filter((s) => s.contract_id === id);
}

export function localNeurons(): readonly ContractNeuronSpec[] {
  return CONTRACT_REGISTRY.filter((s) => s.locality === "local-only");
}

export function paidNeurons(): readonly ContractNeuronSpec[] {
  return CONTRACT_REGISTRY.filter((s) => s.paid === true);
}

export function neuronCount(): number {
  return CONTRACT_REGISTRY.length;
}
