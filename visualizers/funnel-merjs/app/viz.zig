const std = @import("std");
const mer = @import("mer");
const store = @import("viz_store");

pub const meta: mer.Meta = .{
    .title = "Unbrowse Viz Session",
    .description = "Session-backed analytics visualization.",
    .extra_head = "<style>" ++ page_css ++ "</style>",
};

pub fn render(req: mer.Request) mer.Response {
    const id = req.queryParam("id") orelse return mer.badRequest("missing id");
    const raw = store.readSession(req.allocator, id) catch return mer.notFound();
    const overlay = req.queryParam("overlay") != null;

    const encoded_len = std.base64.standard.Encoder.calcSize(raw.len);
    const encoded = req.allocator.alloc(u8, encoded_len) catch return mer.internalError("alloc failed");
    _ = std.base64.standard.Encoder.encode(encoded, raw);

    var html: std.ArrayList(u8) = .{};
    defer html.deinit(req.allocator);
    const writer = html.writer(req.allocator);

    if (overlay) writer.writeAll(overlay_head) catch return mer.internalError("alloc failed");
    writer.writeAll(page_head) catch return mer.internalError("alloc failed");
    writer.writeAll(id) catch return mer.internalError("alloc failed");
    writer.writeAll(page_mid) catch return mer.internalError("alloc failed");
    writer.writeAll(id) catch return mer.internalError("alloc failed");
    writer.writeAll(page_tail_prefix) catch return mer.internalError("alloc failed");
    writer.writeAll(encoded) catch return mer.internalError("alloc failed");
    writer.writeAll(page_tail_suffix) catch return mer.internalError("alloc failed");

    const body = html.toOwnedSlice(req.allocator) catch return mer.internalError("alloc failed");
    return mer.html(body);
}

const overlay_head =
    \\<style>
    \\html, body { background: transparent !important; }
    \\.shell { max-width: none !important; padding: 0 !important; }
    \\.masthead { display: none !important; }
    \\.frame { border: 0 !important; background: transparent !important; box-shadow: none !important; }
    \\.frame-inner { padding: 0 !important; }
    \\.viz-hero { display: none !important; }
    \\.session-pill { background: rgba(9, 7, 7, 0.54) !important; backdrop-filter: blur(24px); }
    \\.prompt-card, .viz-card { background: rgba(13, 10, 10, 0.58) !important; backdrop-filter: blur(28px); border-color: rgba(255,255,255,0.1) !important; }
    \\.viz-root { padding: 14px; }
    \\</style>
;

const page_head =
    \\<section class="viz-hero">
    \\  <div>
    \\    <div class="viz-kicker mono">session-backed viz</div>
    \\    <h1 class="viz-title">analytics into visual memory.</h1>
    \\    <p class="viz-sub">This route renders whatever analytics payload the skill pushed into the local viz session API. No fixed canvas. Sections grow as the payload demands.</p>
    \\  </div>
    \\  <div class="viz-links">
    \\    <a class="viz-link mono" href="/api/viz?id=
;

const page_mid =
    \\" target="_blank" rel="noreferrer">session json</a>
    \\    <a class="viz-link mono" href="/json-render">lab</a>
    \\  </div>
    \\</section>
    \\<div class="session-pill mono">session · 
;

const page_tail_prefix =
    \\</div>
    \\<div id="viz-root" class="viz-root"></div>
    \\<script>
    \\const session = JSON.parse(atob("
;

const page_tail_suffix =
    \\"));
    \\const root = document.getElementById("viz-root");
    \\
    \\function titleize(value) {
    \\  return String(value || "")
    \\    .replace(/[_-]+/g, " ")
    \\    .replace(/([a-z])([A-Z])/g, "$1 $2")
    \\    .replace(/\\s+/g, " ")
    \\    .trim()
    \\    .replace(/^\\w/, (c) => c.toUpperCase());
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
    \\function primitiveRowsFromObject(obj, prefix = "", limit = 12, depth = 0, rows = []) {
    \\  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return rows;
    \\  for (const [key, value] of Object.entries(obj)) {
    \\    if (rows.length >= limit) break;
    \\    const label = prefix ? `${prefix} · ${titleize(key)}` : titleize(key);
    \\    if (isPrimitive(value)) {
    \\      rows.push({ label, value: fmtValue(value), sub: typeof value === "number" ? "number" : "" });
    \\      continue;
    \\    }
    \\    if (depth < 1 && value && typeof value === "object" && !Array.isArray(value)) primitiveRowsFromObject(value, label, limit, depth + 1, rows);
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
    \\    return hasLabel && hasValue ? "lane" : "table";
    \\  }
    \\  return "mixed";
    \\}
    \\
    \\function laneItemsFromArray(title, arr) {
    \\  if (!Array.isArray(arr) || !arr.length) return [];
    \\  if (arr.every((item) => typeof item === "number")) {
    \\    return arr.slice(0, 8).map((value, index) => ({ label: `${title} ${index + 1}`, value: Number(value || 0), rate: null }));
    \\  }
    \\  return arr.slice(0, 8).map((item, index) => {
    \\    const label = item.label || item.name || item.stage || item.key || item.title || item.date || `${title} ${index + 1}`;
    \\    const value = Number(item.value ?? item.count ?? item.users ?? item.sessions ?? item.active ?? item.installs ?? item.revenue ?? 0);
    \\    const rateRaw = item.rate ?? item.share ?? item.conversion_from_previous ?? item.install_copy_rate_after_view ?? null;
    \\    return { label: titleize(label), value, rate: typeof rateRaw === "number" ? rateRaw : null };
    \\  });
    \\}
    \\
    \\function tableRowsFromArray(arr) {
    \\  return (arr || []).slice(0, 10).map((item, index) => {
    \\    const entries = Object.entries(item || {});
    \\    const primaryKey = ["name", "label", "title", "campaign_id", "key", "date", "id"].find((key) => key in (item || {})) || entries[0]?.[0] || `row_${index + 1}`;
    \\    const primary = fmtValue(item?.[primaryKey] ?? primaryKey);
    \\    const other = entries.filter(([key]) => key !== primaryKey);
    \\    const stats = other.slice(0, 3).map(([key, value]) => `${titleize(key)}: ${fmtValue(value)}`);
    \\    return { primary, secondary: other.length > 3 ? `${other.length - 3} more fields` : "", stats };
    \\  });
    \\}
    \\
    \\function collectSections(payload, title = "Payload", depth = 0, sections = []) {
    \\  if (payload == null) return sections;
    \\  if (Array.isArray(payload)) {
    \\    sections.push({ title, kind: "array", data: payload });
    \\    return sections;
    \\  }
    \\  if (typeof payload === "object") {
    \\    sections.push({ title, kind: "object", data: payload });
    \\    if (depth < 1) {
    \\      for (const [key, value] of Object.entries(payload)) {
    \\        if (typeof value === "object" && value !== null) collectSections(value, title === "Payload" ? titleize(key) : `${title} · ${titleize(key)}`, depth + 1, sections);
    \\      }
    \\    }
    \\  }
    \\  return sections;
    \\}
    \\
    \\function scoreSection(section, prompt) {
    \\  const text = `${section.title} ${JSON.stringify(section.data).slice(0, 260)}`.toLowerCase();
    \\  let score = section.kind === "array" ? 2 : 0;
    \\  for (const token of String(prompt || "").toLowerCase().split(/\\s+/).filter(Boolean)) if (text.includes(token)) score += 4;
    \\  if (/funnel|retention|conversion|cohort|stage|activation|campaign|install/.test(text)) score += 2;
    \\  return score;
    \\}
    \\
    \\function metricGrid(items) {
    \\  return `<div class="metric-grid">${items.map((item) => `
    \\    <div class="metric-card">
    \\      <div class="metric-label mono">${item.label}</div>
    \\      <div class="metric-value">${item.value}</div>
    \\      ${item.sub ? `<div class="metric-sub">${item.sub}</div>` : ""}
    \\    </div>`).join("")}</div>`;
    \\}
    \\
    \\function funnelChart(title, items, note) {
    \\  const max = Math.max(1, ...items.map((item) => Number(item.value || 0)));
    \\  return `<div class="funnel-card">
    \\    <div class="funnel-head">
    \\      <div class="lane-title">${title}</div>
    \\      <div class="lane-note">${note}</div>
    \\    </div>
    \\    <div class="funnel-stack">
    \\      ${items.map((item, index) => {
    \\        const current = Number(item.value || 0);
    \\        const next = Number(items[index + 1]?.value ?? current * 0.68);
    \\        const topWidth = Math.max(34, Math.round((current / max) * 100));
    \\        const bottomWidth = Math.max(24, Math.round((next / max) * 100));
    \\        const glow = Math.max(0.28, current / max);
    \\        return `
    \\          <div class="funnel-row">
    \\            <div class="funnel-labels">
    \\              <span>${item.label}</span>
    \\              <span class="mono">${current.toLocaleString()}${item.rate != null ? ` · ${Math.round(item.rate * 100)}%` : ""}</span>
    \\            </div>
    \\            <div class="funnel-stage-shell">
    \\              <div class="funnel-stage" style="--top:${topWidth}%; --bottom:${bottomWidth}%; --glow:${glow};"></div>
    \\            </div>
    \\          </div>`;
    \\      }).join("")}
    \\    </div>
    \\  </div>`;
    \\}
    \\
    \\function lane(title, items, note) {
    \\  const max = Math.max(1, ...items.map((item) => Number(item.value || 0)));
    \\  return `<div class="lane">
    \\    <div class="lane-head"><div class="lane-title">${title}</div><div class="lane-note">${note}</div></div>
    \\    ${items.map((item) => `
    \\      <div class="lane-row">
    \\        <div class="lane-meta"><span>${item.label}</span><span class="mono">${Number(item.value || 0).toLocaleString()}${item.rate != null ? ` · ${Math.round(item.rate * 100)}%` : ""}</span></div>
    \\        <div class="lane-track"><div class="lane-bar" style="width:${Math.round((Number(item.value || 0) / max) * 100)}%"></div></div>
    \\      </div>`).join("")}
    \\  </div>`;
    \\}
    \\
    \\function table(title, rows) {
    \\  return `<div class="table-wrap">
    \\    <div class="table-title">${title}</div>
    \\    <div class="table-grid">${rows.map((row) => `
    \\      <div class="table-row">
    \\        <div><div class="row-title">${row.primary}</div>${row.secondary ? `<div class="row-sub mono">${row.secondary}</div>` : ""}</div>
    \\        <div class="row-stats mono">${row.stats.map((stat) => `<span>${stat}</span>`).join("")}</div>
    \\      </div>`).join("")}</div>
    \\  </div>`;
    \\}
    \\
    \\function card(title, eyebrow, body, tone = "default") {
    \\  return `<section class="viz-card tone-${tone}">
    \\    <div class="viz-eyebrow mono">${eyebrow}</div>
    \\    <h2 class="viz-card-title">${title}</h2>
    \\    ${body}
    \\  </section>`;
    \\}
    \\
    \\function looksLikeFunnel(items, title) {
    \\  if (!items.length) return false;
    \\  const lower = String(title || "").toLowerCase();
    \\  if (/funnel|drop|stage|activation|retention|install|success|conversion/.test(lower)) return true;
    \\  const descending = items.every((item, index) => index === 0 || Number(item.value || 0) <= Number(items[index - 1].value || 0));
    \\  return descending && items.length >= 3;
    \\}
    \\
    \\function renderSession(envelope) {
    \\  const payload = envelope.payload || {};
    \\  const prompt = envelope.prompt || "show me what matters";
    \\  const sections = collectSections(payload).sort((a, b) => scoreSection(b, prompt) - scoreSection(a, prompt)).slice(0, 12);
    \\  const metrics = primitiveRowsFromObject(payload, "", 8);
    \\  const funnelCandidate = sections
    \\    .filter((section) => section.kind === "array")
    \\    .map((section) => ({ section, items: laneItemsFromArray(section.title, section.data) }))
    \\    .find((entry) => looksLikeFunnel(entry.items, entry.section.title));
    \\  const left = [];
    \\  const right = [];
    \\  let col = 0;
    \\  for (const section of sections) {
    \\    const target = col % 2 === 0 ? left : right;
    \\    if (section.kind === "array") {
    \\      const arrayKind = classifyArray(section.data);
    \\      if (arrayKind === "lane" || arrayKind === "numbers") {
    \\        const items = laneItemsFromArray(section.title, section.data);
    \\        const body = looksLikeFunnel(items, section.title)
    \\          ? funnelChart(section.title, items, arrayKind === "numbers" ? "numeric sequence" : "derived from structured rows")
    \\          : lane(section.title, items, arrayKind === "numbers" ? "numeric sequence" : "derived from structured rows");
    \\        target.push(card(section.title, "array", body, /funnel|retention|campaign|stage/i.test(section.title) ? "accent" : "default"));
    \\      } else if (arrayKind === "table") {
    \\        target.push(card(section.title, "array", table(section.title, tableRowsFromArray(section.data))));
    \\      } else if (arrayKind === "strings") {
    \\        target.push(card(section.title, "array", `<p class="viz-text">${section.data.slice(0, 12).join(" | ")}</p>`));
    \\      } else {
    \\        target.push(card(section.title, "array", `<pre class="viz-pre mono">${JSON.stringify(section.data, null, 2).slice(0, 2000)}</pre>`));
    \\      }
    \\    } else {
    \\      const rows = primitiveRowsFromObject(section.data, "", 8);
    \\      target.push(card(section.title, "object", rows.length ? metricGrid(rows) : `<pre class="viz-pre mono">${JSON.stringify(section.data, null, 2).slice(0, 2000)}</pre>`));
    \\    }
    \\    col += 1;
    \\  }
    \\  root.innerHTML = `
    \\    <section class="session-strip">
    \\      <div class="session-pill mono">source · ${envelope.source || "manual"}</div>
    \\      <div class="session-pill mono">hints · ${(envelope.view_hints || []).join(", ") || "none"}</div>
    \\    </section>
    \\    <section class="prompt-card">
    \\      <div class="viz-eyebrow mono">prompt</div>
    \\      <div class="prompt-body">${prompt}</div>
    \\      ${metrics.length ? metricGrid(metrics) : ""}
    \\    </section>
    \\    ${funnelCandidate ? `<section class="viz-card tone-accent funnel-hero">
    \\      <div class="viz-eyebrow mono">funnel focus</div>
    \\      <h2 class="viz-card-title">${funnelCandidate.section.title}</h2>
    \\      ${funnelChart(funnelCandidate.section.title, funnelCandidate.items, "auto-selected from the payload")}
    \\    </section>` : ""}
    \\    <section class="viz-columns">
    \\      <div class="viz-col">${left.join("")}</div>
    \\      <div class="viz-col">${right.join("")}</div>
    \\    </section>`;
    \\}
    \\
    \\renderSession(session);
    \\</script>
;

const page_css =
    \\.viz-hero { display:grid; grid-template-columns: 1fr auto; gap:18px; align-items:start; margin-bottom:18px; }
    \\.viz-kicker { color: var(--accent); text-transform: uppercase; letter-spacing: 0.18em; font-size: 11px; margin-bottom: 10px; }
    \\.viz-title { margin: 0; font-size: clamp(2rem, 4vw, 4.3rem); line-height: 0.95; letter-spacing: -0.05em; }
    \\.viz-sub { margin: 14px 0 0; color: var(--muted); max-width: 820px; line-height: 1.5; }
    \\.viz-links, .session-strip { display:flex; gap:10px; flex-wrap:wrap; }
    \\.viz-link, .session-pill { border:1px solid var(--line); border-radius:999px; padding:10px 14px; background: rgba(255,255,255,0.03); color: var(--muted); }
    \\.viz-root { display:grid; gap:18px; }
    \\.prompt-card, .viz-card { border:1px solid var(--line); border-radius:24px; background: rgba(20,16,14,0.9); padding:18px; }
    \\.prompt-body { font-size: 1.05rem; line-height: 1.5; margin-bottom: 16px; }
    \\.viz-columns { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:18px; align-items:start; }
    \\.viz-col { display:grid; gap:18px; align-content:start; }
    \\.viz-card.tone-accent { background: linear-gradient(180deg, rgba(255,138,61,0.18), rgba(35,28,24,0.82)); }
    \\.viz-card-title { margin: 0 0 12px; letter-spacing: -0.03em; }
    \\.viz-eyebrow, .metric-label { color: var(--accent); text-transform: uppercase; letter-spacing: 0.16em; font-size: 10px; }
    \\.viz-text { margin:0; line-height:1.55; color: var(--muted); }
    \\.viz-pre { margin:0; overflow:auto; border:1px dashed rgba(255,255,255,0.12); border-radius:18px; padding:14px; background: rgba(255,255,255,0.02); font-size:11px; }
    \\.funnel-hero { overflow:hidden; }
    \\.funnel-card { display:grid; gap:14px; }
    \\.funnel-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; }
    \\.funnel-stack { display:grid; gap:10px; }
    \\.funnel-row { display:grid; gap:8px; }
    \\.funnel-labels { display:flex; justify-content:space-between; gap:14px; font-size:0.96rem; }
    \\.funnel-stage-shell { display:flex; justify-content:center; padding: 0 8px; }
    \\.funnel-stage {
    \\  width: var(--top);
    \\  height: 54px;
    \\  clip-path: polygon(calc((100% - var(--top)) / 2) 0%, calc(100% - ((100% - var(--top)) / 2)) 0%, calc(100% - ((100% - var(--bottom)) / 2)) 100%, calc((100% - var(--bottom)) / 2) 100%);
    \\  background:
    \\    linear-gradient(135deg, rgba(255,240,220,0.82), rgba(255,138,61,0.92) 42%, rgba(114,41,7,0.98));
    \\  box-shadow:
    \\    0 0 0 1px rgba(255,255,255,0.07) inset,
    \\    0 18px 36px rgba(0,0,0,0.28),
    \\    0 0 44px rgba(255,138,61, calc(var(--glow) * 0.46));
    \\  border-radius: 14px;
    \\}
    \\.metric-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:12px; }
    \\.metric-card { border:1px solid rgba(255,255,255,0.06); border-radius:18px; padding:14px; background: rgba(255,255,255,0.02); min-height: 104px; }
    \\.metric-value { font-size: 1.35rem; letter-spacing: -0.05em; }
    \\.metric-sub, .lane-note, .row-sub { color: var(--muted); }
    \\.lane { display:grid; gap:12px; }
    \\.lane-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; }
    \\.lane-row, .table-row { border-top:1px solid rgba(255,255,255,0.06); padding-top:10px; }
    \\.lane-row:first-child, .table-row:first-child { border-top:0; padding-top:0; }
    \\.lane-meta { display:flex; justify-content:space-between; gap:14px; margin-bottom:6px; }
    \\.lane-track { height:12px; border-radius:999px; background: rgba(255,255,255,0.06); overflow:hidden; }
    \\.lane-bar { height:100%; border-radius:999px; background: linear-gradient(90deg, #ff8a3d, #ffd099); }
    \\.table-grid { display:grid; gap:10px; }
    \\.table-row { display:flex; justify-content:space-between; gap:14px; align-items:flex-start; }
    \\.row-title, .table-title, .lane-title { font-size: 0.98rem; }
    \\.row-stats { display:flex; gap:10px; flex-wrap:wrap; color: var(--muted); font-size:11px; text-transform:uppercase; }
    \\@media (max-width: 1100px) {
    \\  .viz-hero, .viz-columns { grid-template-columns: 1fr; }
    \\}
;
