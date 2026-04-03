const mer = @import("mer");

pub const meta: mer.Meta = .{
    .title = "Unbrowse JSON Render Lab",
    .description = "merjs shell for prompt-driven, arbitrary-data visualization experiments.",
    .extra_head = "<style>" ++ page_css ++ "</style>",
};

pub fn render(req: mer.Request) mer.Response {
    _ = req;
    return mer.html(page_html);
}

const page_html =
    \\<section class="lab-shell">
    \\  <div class="lab-left">
    \\    <div class="lab-kicker mono">desktop-ready merjs shell</div>
    \\    <h1 class="lab-title">arbitrary data -> spec -> visual.</h1>
    \\    <p class="lab-sub">Paste, drop, or load any analytics JSON, pick a focus prompt, and let the json-render island turn it into cards, lanes, tables, and summaries. Live Unbrowse funnel snapshot is just one input source.</p>
    \\    <div class="lab-links">
    \\      <a class="lab-link mono" href="/">funnel</a>
    \\      <a class="lab-link mono" href="/api/snapshot?days=30" target="_blank" rel="noreferrer">snapshot</a>
    \\    </div>
    \\  </div>
    \\  <div class="lab-status mono" id="lab-status">booting json-render…</div>
    \\</section>
    \\<div id="json-render-root"></div>
    \\<script type="module">
    \\const statusEl = document.getElementById("lab-status");
    \\const reportBootError = (prefix, err) => {
    \\  const message = err?.stack || err?.message || String(err);
    \\  console.error(prefix, err);
    \\  statusEl.textContent = `${prefix} → ${message}`;
    \\};
    \\window.addEventListener("error", (event) => reportBootError("window error", event.error || event.message));
    \\window.addEventListener("unhandledrejection", (event) => reportBootError("promise rejected", event.reason));
    \\
    \\(async () => {
    \\  try {
    \\    statusEl.textContent = "loading runtime modules…";
    \\    const ReactModule = await import("https://cdn.jsdelivr.net/npm/react@19.2.4/+esm");
    \\    const ReactDomModule = await import("https://cdn.jsdelivr.net/npm/react-dom@19.2.4/client/+esm");
    \\    const zodModule = await import("https://cdn.jsdelivr.net/npm/zod@4.3.6/+esm");
    \\    const coreModule = await import("https://cdn.jsdelivr.net/npm/@json-render/core@0.16.0/+esm");
    \\    const reactRenderModule = await import("https://cdn.jsdelivr.net/npm/@json-render/react@0.16.0/+esm");
    \\    const React = ReactModule.default ?? ReactModule;
    \\    const { createRoot } = ReactDomModule;
    \\    const { z } = zodModule;
    \\    const { defineCatalog, createSpecStreamCompiler } = coreModule;
    \\    const { schema, Renderer, StateProvider, VisibilityProvider, ValidationProvider, ActionProvider, defineRegistry } = reactRenderModule;
    \\    const e = React.createElement;
    \\
    \\const ROW = z.object({
    \\  label: z.string(),
    \\  value: z.string(),
    \\  sub: z.string().nullable().optional(),
    \\});
    \\const LANE_ITEM = z.object({
    \\  label: z.string(),
    \\  value: z.number(),
    \\  rate: z.number().nullable().optional(),
    \\});
    \\const TABLE_ROW = z.object({
    \\  primary: z.string(),
    \\  secondary: z.string().nullable().optional(),
    \\  statA: z.string(),
    \\  statB: z.string(),
    \\  statC: z.string(),
    \\});
    \\const TEXT_BLOCK = z.object({
    \\  content: z.string(),
    \\});
    \\
    \\const catalog = defineCatalog(schema, {
    \\  components: {
    \\    Stack: {
    \\      props: z.object({
    \\        gap: z.enum(["sm", "md", "lg"]).nullable().optional(),
    \\        columns: z.number().nullable().optional(),
    \\      }),
    \\      description: "Flexible stack or grid container.",
    \\    },
    \\    Card: {
    \\      props: z.object({
    \\        title: z.string(),
    \\        eyebrow: z.string().nullable().optional(),
    \\        tone: z.enum(["default", "accent", "warn"]).nullable().optional(),
    \\      }),
    \\      description: "Card shell with optional eyebrow.",
    \\    },
    \\    Text: {
    \\      props: z.object({
    \\        content: z.string(),
    \\        tone: z.enum(["default", "muted"]).nullable().optional(),
    \\      }),
    \\      description: "Paragraph block.",
    \\    },
    \\    MetricGrid: {
    \\      props: z.object({
    \\        items: z.array(ROW),
    \\      }),
    \\      description: "Grid of metrics.",
    \\    },
    \\    FunnelLane: {
    \\      props: z.object({
    \\        title: z.string(),
    \\        note: z.string(),
    \\        items: z.array(LANE_ITEM),
    \\      }),
    \\      description: "Bar lane for ordered quantitative items.",
    \\    },
    \\    FunnelChart: {
    \\      props: z.object({
    \\        title: z.string(),
    \\        note: z.string(),
    \\        items: z.array(LANE_ITEM),
    \\      }),
    \\      description: "Tapered funnel chart for ordered conversion stages.",
    \\    },
    \\    DataTable: {
    \\      props: z.object({
    \\        title: z.string(),
    \\        rows: z.array(TABLE_ROW),
    \\      }),
    \\      description: "Compact multi-column table.",
    \\    },
    \\    PromptDeck: {
    \\      props: z.object({
    \\        prompt: z.string(),
    \\        source: z.string(),
    \\      }),
    \\      description: "Prompt and source summary.",
    \\    },
    \\    JsonPreview: {
    \\      props: z.object({
    \\        content: z.string(),
    \\      }),
    \\      description: "Small JSON preview block.",
    \\    },
    \\  },
    \\  actions: {},
    \\});
    \\
    \\const { registry } = defineRegistry(catalog, {
    \\  components: {
    \\    Stack: ({ props, children }) => e(
    \\      "div",
    \\      {
    \\        className: [
    \\          "jr-stack",
    \\          `gap-${props.gap || "md"}`,
    \\          props.columns ? `cols-${Math.max(1, Math.min(3, props.columns))}` : "",
    \\        ].filter(Boolean).join(" "),
    \\      },
    \\      children
    \\    ),
    \\    Card: ({ props, children }) => e(
    \\      "section",
    \\      { className: `jr-card tone-${props.tone || "default"}` },
    \\      props.eyebrow ? e("div", { className: "jr-eyebrow mono" }, props.eyebrow) : null,
    \\      e("h2", { className: "jr-card-title" }, props.title),
    \\      children
    \\    ),
    \\    Text: ({ props }) => e(
    \\      "p",
    \\      { className: `jr-text tone-${props.tone || "default"}` },
    \\      props.content
    \\    ),
    \\    PromptDeck: ({ props }) => e(
    \\      "div",
    \\      { className: "jr-prompt-deck" },
    \\      e("div", { className: "mono jr-mini-label" }, props.source),
    \\      e("div", { className: "jr-prompt-body" }, props.prompt)
    \\    ),
    \\    JsonPreview: ({ props }) => e(
    \\      "pre",
    \\      { className: "jr-inline-json mono" },
    \\      props.content
    \\    ),
    \\    MetricGrid: ({ props }) => e(
    \\      "div",
    \\      { className: "jr-metric-grid" },
    \\      props.items.map((item, index) => e(
    \\        "div",
    \\        { className: "jr-metric-card", key: `${item.label}-${index}` },
    \\        e("div", { className: "mono jr-mini-label" }, item.label),
    \\        e("div", { className: "jr-metric-value" }, item.value),
    \\        item.sub ? e("div", { className: "jr-metric-sub" }, item.sub) : null
    \\      ))
    \\    ),
    \\    FunnelLane: ({ props }) => {
    \\      const max = Math.max(1, ...props.items.map((item) => Number(item.value || 0)));
    \\      return e(
    \\        "div",
    \\        { className: "jr-funnel-lane" },
    \\        e("div", { className: "jr-lane-head" },
    \\          e("div", { className: "jr-lane-title" }, props.title),
    \\          e("div", { className: "jr-lane-note" }, props.note)
    \\        ),
    \\        props.items.map((item, index) => e(
    \\          "div",
    \\          { className: "jr-lane-row", key: `${item.label}-${index}` },
    \\          e("div", { className: "jr-lane-meta" },
    \\            e("span", null, item.label),
    \\            e("span", { className: "mono" }, `${Number(item.value || 0).toLocaleString()}${item.rate != null ? ` · ${Math.round(item.rate * 100)}%` : ""}`)
    \\          ),
    \\          e("div", { className: "jr-lane-track" },
    \\            e("div", { className: "jr-lane-bar", style: { width: `${Math.round((Number(item.value || 0) / max) * 100)}%` } })
    \\          )
    \\        ))
    \\      );
    \\    },
    \\    FunnelChart: ({ props }) => e(
    \\      "div",
    \\      { className: "jr-funnel-chart" },
    \\      e("div", { className: "jr-lane-head" },
    \\        e("div", { className: "jr-lane-title" }, props.title),
    \\        e("div", { className: "jr-lane-note" }, props.note)
    \\      ),
    \\      e("div", { className: "jr-funnel-stack" },
    \\        props.items.map((item, index) => {
    \\          const max = Math.max(1, ...props.items.map((row) => Number(row.value || 0)));
    \\          const current = Number(item.value || 0);
    \\          const next = Number(props.items[index + 1]?.value ?? current * 0.68);
    \\          const topWidth = Math.max(34, Math.round((current / max) * 100));
    \\          const bottomWidth = Math.max(24, Math.round((next / max) * 100));
    \\          const glow = Math.max(0.28, current / max);
    \\          return e(
    \\            "div",
    \\            { className: "jr-funnel-row", key: `${item.label}-${index}` },
    \\            e("div", { className: "jr-lane-meta" },
    \\              e("span", null, item.label),
    \\              e("span", { className: "mono" }, `${current.toLocaleString()}${item.rate != null ? ` · ${Math.round(item.rate * 100)}%` : ""}`)
    \\            ),
    \\            e("div", { className: "jr-funnel-stage-shell" },
    \\              e("div", {
    \\                className: "jr-funnel-stage",
    \\                style: {
    \\                  "--top": `${topWidth}%`,
    \\                  "--bottom": `${bottomWidth}%`,
    \\                  "--glow": glow,
    \\                },
    \\              })
    \\            )
    \\          );
    \\        })
    \\      )
    \\    ),
    \\    DataTable: ({ props }) => e(
    \\      "div",
    \\      { className: "jr-table-wrap" },
    \\      e("div", { className: "jr-table-title" }, props.title),
    \\      e("div", { className: "jr-table" },
    \\        props.rows.map((row, index) => e(
    \\          "div",
    \\          { className: "jr-table-row", key: `${row.primary}-${index}` },
    \\          e("div", null,
    \\            e("div", { className: "jr-row-title" }, row.primary),
    \\            row.secondary ? e("div", { className: "jr-row-sub mono" }, row.secondary) : null
    \\          ),
    \\          e("div", { className: "jr-table-stats mono" },
    \\            e("span", null, row.statA),
    \\            e("span", null, row.statB),
    \\            e("span", null, row.statC)
    \\          )
    \\        ))
    \\      )
    \\    ),
    \\  },
    \\});
    \\
    \\function titleize(value) {
    \\  return String(value || "")
    \\    .replace(/[_-]+/g, " ")
    \\    .replace(/([a-z])([A-Z])/g, "$1 $2")
    \\    .replace(/\s+/g, " ")
    \\    .trim()
    \\    .replace(/^\w/, (c) => c.toUpperCase());
    \\}
    \\
    \\function fmtValue(value) {
    \\  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
    \\  if (typeof value === "boolean") return value ? "true" : "false";
    \\  if (value == null) return "null";
    \\  if (typeof value === "string") return value;
    \\  return JSON.stringify(value);
    \\}
    \\
    \\function isPrimitive(value) {
    \\  return value == null || ["string", "number", "boolean"].includes(typeof value);
    \\}
    \\
    \\function primitiveRowsFromObject(obj, prefix = "", limit = 8, depth = 0, rows = []) {
    \\  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return rows;
    \\  for (const [key, value] of Object.entries(obj)) {
    \\    if (rows.length >= limit) break;
    \\    const label = prefix ? `${prefix} · ${titleize(key)}` : titleize(key);
    \\    if (isPrimitive(value)) {
    \\      rows.push({ label, value: fmtValue(value), sub: typeof value === "number" ? "number" : null });
    \\      continue;
    \\    }
    \\    if (depth < 1 && value && typeof value === "object" && !Array.isArray(value)) {
    \\      primitiveRowsFromObject(value, label, limit, depth + 1, rows);
    \\    }
    \\  }
    \\  return rows;
    \\}
    \\
    \\function classifyArray(arr) {
    \\  if (!Array.isArray(arr) || !arr.length) return "empty";
    \\  if (arr.every((item) => typeof item === "number")) return "numbers";
    \\  if (arr.every((item) => typeof item === "string")) return "strings";
    \\  if (arr.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
    \\    const keys = new Set(arr.flatMap((item) => Object.keys(item)));
    \\    const hasLabel = ["label", "name", "stage", "key", "title", "date"].some((key) => keys.has(key));
    \\    const hasValue = ["value", "count", "users", "sessions", "active", "installs", "revenue"].some((key) => keys.has(key));
    \\    if (hasLabel && hasValue) return "lane";
    \\    return "table";
    \\  }
    \\  return "mixed";
    \\}
    \\
    \\function laneItemsFromArray(title, arr) {
    \\  if (!Array.isArray(arr) || !arr.length) return [];
    \\  if (arr.every((item) => typeof item === "number")) {
    \\    return arr.slice(0, 8).map((value, index) => ({
    \\      label: `${title} ${index + 1}`,
    \\      value: Number(value || 0),
    \\      rate: null,
    \\    }));
    \\  }
    \\  return arr.slice(0, 8).map((item, index) => {
    \\    const label = item.label || item.name || item.stage || item.key || item.title || item.date || `${title} ${index + 1}`;
    \\    const value = Number(item.value ?? item.count ?? item.users ?? item.sessions ?? item.active ?? item.installs ?? item.revenue ?? 0);
    \\    const rateRaw = item.rate ?? item.share ?? item.conversion_from_previous ?? item.install_copy_rate_after_view ?? null;
    \\    const rate = typeof rateRaw === "number" ? rateRaw : null;
    \\    return { label: titleize(label), value, rate };
    \\  });
    \\}
    \\
    \\function tableRowsFromArray(arr) {
    \\  return (arr || []).slice(0, 8).map((item, index) => {
    \\    const entries = Object.entries(item || {});
    \\    const primaryKey = ["name", "label", "title", "campaign_id", "key", "date", "id"].find((key) => key in (item || {})) || entries[0]?.[0] || `row_${index + 1}`;
    \\    const primary = fmtValue(item?.[primaryKey] ?? primaryKey);
    \\    const other = entries.filter(([key]) => key !== primaryKey);
    \\    const visible = other.slice(0, 3).map(([key, value]) => `${titleize(key)}: ${fmtValue(value)}`);
    \\    return {
    \\      primary,
    \\      secondary: other.length > 3 ? `${other.length - 3} more fields` : null,
    \\      statA: visible[0] || "—",
    \\      statB: visible[1] || "—",
    \\      statC: visible[2] || "—",
    \\    };
    \\  });
    \\}
    \\
    \\function collectSections(payload, title = "Input", depth = 0, sections = []) {
    \\  if (payload == null) return sections;
    \\  if (Array.isArray(payload)) {
    \\    sections.push({ title, kind: "array", depth, data: payload });
    \\    return sections;
    \\  }
    \\  if (typeof payload === "object") {
    \\    sections.push({ title, kind: "object", depth, data: payload });
    \\    if (depth < 1) {
    \\      for (const [key, value] of Object.entries(payload)) {
    \\        if (typeof value === "object" && value !== null) {
    \\          collectSections(value, title === "Input" ? titleize(key) : `${title} · ${titleize(key)}`, depth + 1, sections);
    \\        }
    \\      }
    \\    }
    \\  }
    \\  return sections;
    \\}
    \\
    \\function scoreSection(section, focus) {
    \\  const text = `${section.title} ${JSON.stringify(section.data).slice(0, 240)}`.toLowerCase();
    \\  let score = 0;
    \\  for (const token of focus.split(/\s+/).filter(Boolean)) {
    \\    if (text.includes(token)) score += 4;
    \\  }
    \\  if (section.kind === "array") score += 2;
    \\  if (/funnel|retention|conversion|cohort|stage|activation/.test(text)) score += 2;
    \\  return score;
    \\}
    \\
    \\function encodeBase64Url(text) {
    \\  return btoa(unescape(encodeURIComponent(text)))
    \\    .replace(/\+/g, "-")
    \\    .replace(/\//g, "_")
    \\    .replace(/=+$/g, "");
    \\}
    \\
    \\function decodeBase64Url(text) {
    \\  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
    \\  const normalized = padded + "=".repeat((4 - (padded.length % 4 || 4)) % 4);
    \\  return decodeURIComponent(escape(atob(normalized)));
    \\}
    \\
    \\function encodeHashState(prompt, payload) {
    \\  return `state=${encodeBase64Url(JSON.stringify({ prompt, payload }))}`;
    \\}
    \\
    \\function decodeHashState() {
    \\  const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
    \\  if (!raw) return null;
    \\  const params = new URLSearchParams(raw);
    \\  const state = params.get("state");
    \\  if (!state) return null;
    \\  return JSON.parse(decodeBase64Url(state));
    \\}
    \\
    \\const DEMO_FUNNEL = {
    \\  stages: [
    \\    { stage: "Landing", value: 1420, rate: 1 },
    \\    { stage: "Install copy", value: 263, rate: 0.19 },
    \\    { stage: "Reported install", value: 119, rate: 0.45 },
    \\    { stage: "First success", value: 54, rate: 0.45 },
    \\    { stage: "Repeat", value: 19, rate: 0.35 },
    \\    { stage: "Retained d30", value: 7, rate: 0.37 }
    \\  ],
    \\  campaigns: [
    \\    { campaign_id: "openclaw_normie_v2", channel: "x", landing_sessions: 422, install_command_copies: 96, first_resolve_succeeded: 18 },
    \\    { campaign_id: "agent_builder_playwright_alt", channel: "google", landing_sessions: 318, install_command_copies: 71, first_resolve_succeeded: 21 }
    \\  ],
    \\  summary: {
    \\    spend_usd: 640,
    \\    cac_usd: 11.85,
    \\    activation_rate: 0.45,
    \\    retention_d30: 0.13
    \\  }
    \\};
    \\
    \\const DEMO_GENERIC = {
    \\  monthly_revenue: 48210,
    \\  growth_pct: 0.12,
    \\  regions: {
    \\    apac: 18120,
    \\    us: 20330,
    \\    eu: 9760
    \\  },
    \\  weekly_active: [
    \\    { date: "2026-03-01", active: 202 },
    \\    { date: "2026-03-08", active: 231 },
    \\    { date: "2026-03-15", active: 248 },
    \\    { date: "2026-03-22", active: 297 }
    \\  ],
    \\  plans: [
    \\    { name: "Free", users: 820, conversion: 0.0, churn: 0.21 },
    \\    { name: "Pro", users: 143, conversion: 0.17, churn: 0.08 },
    \\    { name: "Team", users: 28, conversion: 0.03, churn: 0.04 }
    \\  ]
    \\};
    \\
    \\function App() {
    \\  const fileInputRef = React.useRef(null);
    \\  const [prompt, setPrompt] = React.useState("show the whole funnel");
    \\  const [dataText, setDataText] = React.useState(JSON.stringify(DEMO_FUNNEL, null, 2));
    \\  const [spec, setSpec] = React.useState(null);
    \\  const [sourceLabel, setSourceLabel] = React.useState("demo_funnel");
    \\  const [error, setError] = React.useState("");
    \\  const [isStreaming, setIsStreaming] = React.useState(false);
    \\
    \\  async function requestSpec(nextPrompt, payload, nextSource) {
    \\    setIsStreaming(true);
    \\    statusEl.textContent = `streaming spec → ${nextSource}`;
    \\    try {
    \\      const response = await fetch("/api/viz-spec", {
    \\        method: "POST",
    \\        headers: { "Content-Type": "application/json" },
    \\        body: JSON.stringify({
    \\          prompt: nextPrompt,
    \\          source: nextSource,
    \\          payload,
    \\        }),
    \\      });
    \\      if (!response.ok || !response.body) {
    \\        throw new Error(`spec route failed (${response.status})`);
    \\      }
    \\      const compiler = createSpecStreamCompiler();
    \\      const reader = response.body.getReader();
    \\      const decoder = new TextDecoder();
    \\      let latest = null;
    \\      while (true) {
    \\        const { done, value } = await reader.read();
    \\        if (done) break;
    \\        const chunk = decoder.decode(value, { stream: true });
    \\        const result = compiler.push(chunk);
    \\        latest = result.result;
    \\        setSpec(structuredClone(result.result));
    \\      }
    \\      const tail = decoder.decode();
    \\      if (tail) {
    \\        const result = compiler.push(tail);
    \\        latest = result.result;
    \\      }
    \\      if (latest) setSpec(structuredClone(latest));
    \\      setError("");
    \\      statusEl.textContent = `rendered → ${nextSource}`;
    \\    } catch (err) {
    \\      const message = err?.message || String(err);
    \\      setError(message);
    \\      statusEl.textContent = `spec failed → ${message}`;
    \\    } finally {
    \\      setIsStreaming(false);
    \\    }
    \\  }
    \\
    \\  React.useEffect(() => {
    \\    try {
    \\      const query = new URLSearchParams(window.location.search);
    \\      const sessionId = query.get("session_id");
    \\      if (sessionId) {
    \\        fetch(`/api/viz?id=${encodeURIComponent(sessionId)}`)
    \\          .then((response) => response.json())
    \\          .then((envelope) => {
    \\            const nextPrompt = envelope.prompt || "show me what matters in this data";
    \\            const nextText = JSON.stringify(envelope.payload || {}, null, 2);
    \\            setPrompt(nextPrompt);
    \\            setDataText(nextText);
    \\            setSourceLabel(envelope.source || `session:${sessionId}`);
    \\            requestSpec(nextPrompt, envelope.payload || {}, envelope.source || `session:${sessionId}`);
    \\          })
    \\          .catch((err) => {
    \\            const message = err?.message || String(err);
    \\            setError(message);
    \\            statusEl.textContent = `session load failed → ${message}`;
    \\          });
    \\        return;
    \\      }
    \\
    \\      const boot = decodeHashState();
    \\      if (!boot || !boot.payload) {
    \\        requestSpec("show the whole funnel", DEMO_FUNNEL, "demo_funnel");
    \\        return;
    \\      }
    \\      const nextPrompt = typeof boot.prompt === "string" && boot.prompt.trim() ? boot.prompt : "show me what matters in this data";
    \\      const nextText = JSON.stringify(boot.payload, null, 2);
    \\      setPrompt(nextPrompt);
    \\      setDataText(nextText);
    \\      setSourceLabel("shared_state");
    \\      requestSpec(nextPrompt, boot.payload, "shared_state");
    \\    } catch (err) {
    \\      const message = err?.message || String(err);
    \\      setError(message);
    \\      statusEl.textContent = `state decode failed → ${message}`;
    \\    }
    \\  }, []);
    \\
    \\  async function loadLiveSnapshot() {
    \\    statusEl.textContent = "loading live snapshot…";
    \\    try {
    \\      const response = await fetch("/api/snapshot?days=30");
    \\      const data = await response.json();
    \\      const nextText = JSON.stringify(data, null, 2);
    \\      setDataText(nextText);
    \\      setSourceLabel("live_snapshot");
    \\      await requestSpec(prompt, data, "live_snapshot");
    \\      statusEl.textContent = data.configured?.has_api_key
    \\        ? `live snapshot loaded → ${data.configured.backend_url}`
    \\        : `snapshot degraded → ${data.configured?.backend_url || "backend missing"}`;
    \\    } catch (err) {
    \\      const message = err?.message || String(err);
    \\      setError(message);
    \\      statusEl.textContent = `snapshot failed → ${message}`;
    \\    }
    \\  }
    \\
    \\  function renderPayload(nextPrompt, parsed, nextSource) {
    \\    const pretty = JSON.stringify(parsed, null, 2);
    \\    setDataText(pretty);
    \\    setPrompt(nextPrompt);
    \\    setSourceLabel(nextSource);
    \\    requestSpec(nextPrompt, parsed, nextSource);
    \\  }
    \\
    \\  function applyData(nextPrompt = prompt, nextText = dataText, nextSource = sourceLabel) {
    \\    try {
    \\      const parsed = JSON.parse(nextText);
    \\      renderPayload(nextPrompt, parsed, nextSource);
    \\    } catch (err) {
    \\      const message = err?.message || String(err);
    \\      setError(message);
    \\      statusEl.textContent = `invalid json → ${message}`;
    \\    }
    \\  }
    \\
    \\  function onFileChange(event) {
    \\    const file = event.target.files?.[0];
    \\    if (!file) return;
    \\    const reader = new FileReader();
    \\    reader.onload = () => {
    \\      const text = typeof reader.result === "string" ? reader.result : "";
    \\      setDataText(text);
    \\      applyData(prompt, text, file.name || "file_upload");
    \\    };
    \\    reader.onerror = () => {
    \\      const message = reader.error?.message || "failed to read file";
    \\      setError(message);
    \\      statusEl.textContent = `file load failed → ${message}`;
    \\    };
    \\    reader.readAsText(file);
    \\    event.target.value = "";
    \\  }
    \\
    \\  function onDropJson(event) {
    \\    event.preventDefault();
    \\    const file = event.dataTransfer?.files?.[0];
    \\    if (!file) return;
    \\    const reader = new FileReader();
    \\    reader.onload = () => {
    \\      const text = typeof reader.result === "string" ? reader.result : "";
    \\      setDataText(text);
    \\      applyData(prompt, text, file.name || "dropped_file");
    \\    };
    \\    reader.onerror = () => {
    \\      const message = reader.error?.message || "failed to read dropped file";
    \\      setError(message);
    \\      statusEl.textContent = `drop failed → ${message}`;
    \\    };
    \\    reader.readAsText(file);
    \\  }
    \\
    \\  async function copyStateUrl() {
    \\    try {
    \\      const parsed = JSON.parse(dataText);
    \\      const url = new URL(window.location.href);
    \\      url.hash = encodeHashState(prompt, parsed);
    \\      if (url.toString().length > 16000) {
    \\        throw new Error("state too large for share url; use file import instead");
    \\      }
    \\      window.history.replaceState(null, "", url);
    \\      await navigator.clipboard.writeText(url.toString());
    \\      setError("");
    \\      statusEl.textContent = "copied → share url";
    \\    } catch (err) {
    \\      const message = err?.message || String(err);
    \\      setError(message);
    \\      statusEl.textContent = `share failed → ${message}`;
    \\    }
    \\  }
    \\
    \\  return e(
    \\    "div",
    \\    { className: "jr-workbench" },
    \\    e("div", { className: "jr-toolbar-card" },
    \\      e("div", { className: "jr-form-grid" },
    \\        e("div", { className: "jr-field" },
    \\          e("label", { className: "mono jr-field-label" }, "prompt"),
    \\          e("input", {
    \\            className: "jr-input",
    \\            value: prompt,
    \\            onChange: (event) => setPrompt(event.target.value),
    \\            placeholder: "focus on activation, retention, campaigns, cohorts…",
    \\          })
    \\        ),
    \\        e("div", { className: "jr-buttons" },
    \\          e("button", { className: "jr-button", type: "button", onClick: () => applyData(prompt, dataText, sourceLabel) }, "render"),
    \\          e("button", { className: "jr-chip mono", type: "button", onClick: () => fileInputRef.current?.click() }, "load file"),
    \\          e("button", { className: "jr-chip mono", type: "button", onClick: copyStateUrl }, "copy state url"),
    \\          e("button", { className: "jr-chip mono", type: "button", onClick: () => {
    \\            const text = JSON.stringify(DEMO_FUNNEL, null, 2);
    \\            setDataText(text);
    \\            applyData("show the whole funnel", text, "demo_funnel");
    \\          } }, "demo funnel"),
    \\          e("button", { className: "jr-chip mono", type: "button", onClick: () => {
    \\            const text = JSON.stringify(DEMO_GENERIC, null, 2);
    \\            setDataText(text);
    \\            applyData("show me the business in this data", text, "demo_generic");
    \\          } }, "demo generic"),
    \\          e("button", { className: "jr-chip mono", type: "button", onClick: loadLiveSnapshot }, "live snapshot")
    \\        )
    \\      ),
    \\      e("input", {
    \\        ref: fileInputRef,
    \\        className: "jr-file-input",
    \\        type: "file",
    \\        accept: ".json,application/json",
    \\        onChange: onFileChange,
    \\      }),
    \\      e("label", { className: "mono jr-field-label" }, "json input"),
    \\      e("textarea", {
    \\        className: "jr-editor mono",
    \\        value: dataText,
    \\        onChange: (event) => setDataText(event.target.value),
    \\        onDragOver: (event) => event.preventDefault(),
    \\        onDrop: onDropJson,
    \\        spellCheck: false,
    \\      }),
    \\      e("div", { className: "jr-helper mono" }, "paste raw json. or drop a .json file. or copy a state url and reopen it later."),
    \\      error ? e("div", { className: "jr-error" }, error) : null
    \\    ),
    \\    e("div", { className: "jr-render-grid" },
    \\      e(
    \\        "div",
    \\        { className: "jr-rendered" },
    \\        isStreaming ? e("div", { className: "jr-helper mono" }, "streaming patches…") : null,
    \\        e(
    \\          StateProvider,
    \\          { initialState: {} },
    \\          e(
    \\            VisibilityProvider,
    \\            null,
    \\            e(
    \\              ActionProvider,
    \\              { handlers: {} },
    \\              e(
    \\                ValidationProvider,
    \\                { customFunctions: {} },
    \\                spec ? e(Renderer, { spec, registry }) : e("div", { className: "jr-helper mono" }, "waiting for spec…")
    \\              )
    \\            )
    \\          )
    \\        )
    \\      ),
    \\      e("pre", { className: "jr-spec mono" }, JSON.stringify(spec, null, 2))
    \\    )
    \\  );
    \\}
    \\
    \\    createRoot(document.getElementById("json-render-root")).render(e(App));
    \\  } catch (err) {
    \\    reportBootError("boot failed", err);
    \\  }
    \\})();
    \\</script>
;

const page_css =
    \\.lab-shell { display:grid; grid-template-columns: 1fr 320px; gap:18px; align-items:start; margin-bottom:18px; }
    \\.lab-kicker { color: var(--accent); text-transform: uppercase; letter-spacing: 0.18em; font-size: 11px; margin-bottom: 10px; }
    \\.lab-title { margin: 0; font-size: clamp(2rem, 4vw, 4.3rem); line-height: 0.95; letter-spacing: -0.05em; }
    \\.lab-sub { margin: 14px 0 0; color: var(--muted); max-width: 720px; line-height: 1.5; }
    \\.lab-links { display:flex; gap:10px; margin-top:16px; flex-wrap:wrap; }
    \\.lab-link, .lab-status { border:1px solid var(--line); border-radius:999px; padding:10px 14px; background: rgba(255,255,255,0.03); color: var(--muted); }
    \\.lab-status { min-height:44px; display:flex; align-items:center; justify-content:center; background: linear-gradient(180deg, rgba(255,138,61,0.16), rgba(255,255,255,0.03)); color: var(--text); }
    \\.jr-workbench { display:grid; gap:18px; }
    \\.jr-toolbar-card, .jr-rendered, .jr-spec { border:1px solid var(--line); border-radius:24px; background: rgba(20,16,14,0.9); }
    \\.jr-toolbar-card { padding:18px; display:grid; gap:14px; }
    \\.jr-form-grid { display:grid; grid-template-columns: 1fr auto; gap:14px; align-items:end; }
    \\.jr-field { display:grid; gap:8px; }
    \\.jr-field-label, .jr-mini-label, .jr-eyebrow { color: var(--accent); text-transform: uppercase; letter-spacing: 0.16em; font-size: 10px; }
    \\.jr-input, .jr-editor {
    \\  width: 100%; border:1px solid var(--line); border-radius:18px; padding:14px 16px;
    \\  background: rgba(26,21,18,0.95); color: var(--text); font: inherit;
    \\}
    \\.jr-editor { min-height: 260px; resize: vertical; line-height: 1.45; }
    \\.jr-buttons { display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end; }
    \\.jr-button, .jr-chip {
    \\  border:1px solid var(--line); border-radius:999px; padding:12px 14px; background: var(--accent-soft); color: var(--accent); cursor:pointer;
    \\}
    \\.jr-button { font-weight: 600; }
    \\.jr-file-input { display:none; }
    \\.jr-helper { color: var(--muted); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
    \\.jr-error { border-left:3px solid var(--danger); padding:10px 12px; background: rgba(255,91,77,0.08); color: #ffd7cf; }
    \\.jr-render-grid { display:grid; grid-template-columns: minmax(0, 1.25fr) minmax(320px, 0.75fr); gap:18px; align-items:start; }
    \\.jr-rendered { padding:18px; }
    \\.jr-spec { margin:0; padding:18px; overflow:auto; max-height: 78vh; color:#e6d9cd; font-size:12px; line-height:1.5; }
    \\.jr-stack { display:grid; }
    \\.jr-stack.gap-sm { gap:10px; }
    \\.jr-stack.gap-md { gap:14px; }
    \\.jr-stack.gap-lg { gap:18px; }
    \\.jr-stack.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items:start; }
    \\.jr-stack.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); align-items:start; }
    \\.jr-card { border:1px solid rgba(255,255,255,0.08); border-radius:22px; padding:18px; background: rgba(35,28,24,0.82); }
    \\.jr-card.tone-accent { background: linear-gradient(180deg, rgba(255,138,61,0.18), rgba(35,28,24,0.82)); }
    \\.jr-card.tone-warn { background: linear-gradient(180deg, rgba(255,91,77,0.12), rgba(35,28,24,0.82)); }
    \\.jr-card-title { margin: 0; letter-spacing: -0.03em; }
    \\.jr-text { margin: 0; line-height: 1.55; }
    \\.jr-text.tone-muted, .jr-row-sub, .jr-lane-note, .jr-metric-sub { color: var(--muted); }
    \\.jr-inline-json, .jr-prompt-deck { border:1px dashed rgba(255,255,255,0.12); border-radius:18px; padding:14px; background: rgba(255,255,255,0.02); }
    \\.jr-inline-json { margin:0; overflow:auto; max-height: 220px; font-size: 11px; }
    \\.jr-prompt-body { font-size: 1.05rem; line-height: 1.45; }
    \\.jr-metric-grid { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:12px; }
    \\.jr-metric-card { border:1px solid rgba(255,255,255,0.06); border-radius:18px; padding:14px; background: rgba(255,255,255,0.02); }
    \\.jr-metric-value { font-size: 1.35rem; letter-spacing: -0.05em; }
    \\.jr-funnel-lane { display:grid; gap:12px; }
    \\.jr-funnel-chart { display:grid; gap:12px; }
    \\.jr-funnel-stack { display:grid; gap:10px; }
    \\.jr-funnel-row { display:grid; gap:8px; }
    \\.jr-funnel-stage-shell { display:flex; justify-content:center; padding:0 8px; }
    \\.jr-funnel-stage {
    \\  width: var(--top);
    \\  height: 52px;
    \\  clip-path: polygon(calc((100% - var(--top)) / 2) 0%, calc(100% - ((100% - var(--top)) / 2)) 0%, calc(100% - ((100% - var(--bottom)) / 2)) 100%, calc((100% - var(--bottom)) / 2) 100%);
    \\  background: linear-gradient(135deg, rgba(255,240,220,0.82), rgba(255,138,61,0.92) 42%, rgba(114,41,7,0.98));
    \\  box-shadow: 0 0 0 1px rgba(255,255,255,0.07) inset, 0 18px 36px rgba(0,0,0,0.28), 0 0 44px rgba(255,138,61, calc(var(--glow) * 0.46));
    \\  border-radius: 14px;
    \\}
    \\.jr-lane-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; }
    \\.jr-lane-title, .jr-table-title { font-size: 1rem; }
    \\.jr-lane-row, .jr-table-row { border-top:1px solid rgba(255,255,255,0.06); padding-top:10px; }
    \\.jr-lane-row:first-child, .jr-table-row:first-child { border-top:0; padding-top:0; }
    \\.jr-lane-meta { display:flex; justify-content:space-between; gap:14px; margin-bottom:6px; }
    \\.jr-lane-track { height:12px; border-radius:999px; background: rgba(255,255,255,0.06); overflow:hidden; }
    \\.jr-lane-bar { height:100%; border-radius:999px; background: linear-gradient(90deg, #ff8a3d, #ffd099); }
    \\.jr-table { display:grid; gap:10px; }
    \\.jr-table-row { display:flex; justify-content:space-between; gap:14px; align-items:flex-start; }
    \\.jr-row-title { font-size: 0.95rem; }
    \\.jr-table-stats { display:flex; gap:10px; flex-wrap:wrap; color: var(--muted); font-size:11px; text-transform:uppercase; }
    \\@media (max-width: 1100px) {
    \\  .lab-shell, .jr-form-grid, .jr-render-grid, .jr-stack.cols-2, .jr-stack.cols-3, .jr-metric-grid { grid-template-columns: 1fr; }
    \\  .jr-buttons { justify-content:flex-start; }
    \\}
;
