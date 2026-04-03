const std = @import("std");
const mer = @import("mer");

pub const meta: mer.Meta = .{
    .title = "Unbrowse Funnel Command Center",
    .description = "merjs visualization for the whole Unbrowse funnel.",
    .extra_head = "<style>" ++ page_css ++ "</style>",
};

pub fn render(req: mer.Request) mer.Response {
    _ = req;
    return mer.html(page_html);
}

const page_html =
    \\<section class="hero-grid">
    \\  <div class="hero-copy">
    \\    <div class="eyebrow mono">visual operator surface</div>
    \\    <div class="hero-controls">
    \\      <label class="control mono" for="days">window</label>
    \\      <select id="days" class="days-select mono">
    \\        <option value="14">14d</option>
    \\        <option value="30" selected>30d</option>
    \\        <option value="60">60d</option>
    \\        <option value="90">90d</option>
    \\      </select>
    \\      <a class="ghost-link mono" href="/json-render">json-render lab</a>
    \\      <a id="raw-link" class="ghost-link mono" href="/api/snapshot?days=30" target="_blank" rel="noreferrer">raw snapshot</a>
    \\    </div>
    \\  </div>
    \\  <div id="config-status" class="status-card mono">booting snapshot…</div>
    \\</section>
    \\<section id="summary-strip" class="summary-strip"></section>
    \\<section class="board">
    \\  <div class="board-main">
    \\    <div id="lanes" class="lanes"></div>
    \\  </div>
    \\  <aside class="board-side">
    \\    <div class="side-card">
    \\      <div class="side-title">biggest leaks</div>
    \\      <div id="leaks" class="stack"></div>
    \\    </div>
    \\    <div class="side-card">
    \\      <div class="side-title">ICP pull</div>
    \\      <div id="icps" class="stack compact"></div>
    \\    </div>
    \\    <div class="side-card">
    \\      <div class="side-title">landing sections</div>
    \\      <div id="sections" class="stack compact"></div>
    \\    </div>
    \\  </aside>
    \\</section>
    \\<section class="table-grid">
    \\  <div class="table-card">
    \\    <div class="side-title">top campaigns / content ids</div>
    \\    <div id="campaigns" class="table-stack"></div>
    \\  </div>
    \\  <div class="table-card">
    \\    <div class="side-title">instrumentation gaps</div>
    \\    <div id="warnings" class="stack"></div>
    \\  </div>
    \\</section>
    \\<script>
    \\const daysSelect = document.getElementById("days");
    \\const rawLink = document.getElementById("raw-link");
    \\const lanesRoot = document.getElementById("lanes");
    \\const leaksRoot = document.getElementById("leaks");
    \\const campaignsRoot = document.getElementById("campaigns");
    \\const sectionsRoot = document.getElementById("sections");
    \\const icpsRoot = document.getElementById("icps");
    \\const warningsRoot = document.getElementById("warnings");
    \\const summaryRoot = document.getElementById("summary-strip");
    \\const configRoot = document.getElementById("config-status");
    \\
    \\function n(value) {
    \\  return Number(value || 0).toLocaleString();
    \\}
    \\
    \\function pct(value) {
    \\  return `${Math.round(Number(value || 0) * 100)}%`;
    \\}
    \\
    \\function laneCard(lane) {
    \\  const max = Math.max(1, ...lane.steps.map((step) => Number(step.value || 0)));
    \\  return `
    \\    <article class="lane-card">
    \\      <div class="lane-head">
    \\        <div>
    \\          <div class="lane-kicker mono">${lane.kicker}</div>
    \\          <h2>${lane.label}</h2>
    \\        </div>
    \\        <p>${lane.note}</p>
    \\      </div>
    \\      <div class="lane-steps">
    \\        ${lane.steps.map((step) => {
    \\          const width = Math.round((Number(step.value || 0) / max) * 100);
    \\          return `
    \\            <div class="lane-step">
    \\              <div class="lane-step-meta">
    \\                <span>${step.label}</span>
    \\                <span class="mono">${n(step.value)}${step.rate ? ` · ${pct(step.rate)}` : ""}</span>
    \\              </div>
    \\              <div class="lane-bar-track"><div class="lane-bar" style="width:${width}%"></div></div>
    \\            </div>
    \\          `;
    \\        }).join("")}
    \\      </div>
    \\    </article>
    \\  `;
    \\}
    \\
    \\function leakCard(leak) {
    \\  return `
    \\    <div class="list-row">
    \\      <div>
    \\        <div class="list-title">${leak.label}</div>
    \\        <div class="list-sub">${leak.note}</div>
    \\      </div>
    \\      <div class="rate-pill mono">${pct(leak.rate)}</div>
    \\    </div>
    \\  `;
    \\}
    \\
    \\function miniRow(label, value, sub) {
    \\  return `
    \\    <div class="list-row compact">
    \\      <div>
    \\        <div class="list-title">${label}</div>
    \\        <div class="list-sub">${sub || ""}</div>
    \\      </div>
    \\      <div class="rate-pill mono">${value}</div>
    \\    </div>
    \\  `;
    \\}
    \\
    \\function campaignRow(row) {
    \\  return `
    \\    <div class="campaign-row">
    \\      <div class="campaign-main">
    \\        <div class="campaign-title">${row.campaign_name || row.campaign_id}</div>
    \\        <div class="campaign-sub mono">${row.channel}${row.content_id ? ` · ${row.content_id}` : ""}${row.inferred_icp ? ` · ${row.inferred_icp}` : ""}</div>
    \\      </div>
    \\      <div class="campaign-metrics mono">
    \\        <span>${n(row.landing_sessions)} land</span>
    \\        <span>${n(row.install_command_copies)} copy</span>
    \\        <span>${n(row.first_resolve_succeeded)} success</span>
    \\      </div>
    \\    </div>
    \\  `;
    \\}
    \\
    \\function canonicalRate(stages, key) {
    \\  const hit = (stages || []).find((stage) => stage.key === key);
    \\  return hit ? Number(hit.conversion_from_previous || 0) : 0;
    \\}
    \\
    \\function aggregateCampaigns(rows) {
    \\  return (rows || []).reduce((acc, row) => {
    \\    acc.landing_sessions += Number(row.landing_sessions || 0);
    \\    acc.content_page_sessions += Number(row.content_page_sessions || 0);
    \\    acc.install_command_copies += Number(row.install_command_copies || 0);
    \\    acc.reported_installs += Number(row.reported_installs || 0);
    \\    acc.first_resolve_succeeded += Number(row.first_resolve_succeeded || 0);
    \\    return acc;
    \\  }, {
    \\    landing_sessions: 0,
    \\    content_page_sessions: 0,
    \\    install_command_copies: 0,
    \\    reported_installs: 0,
    \\    first_resolve_succeeded: 0,
    \\  });
    \\}
    \\
    \\function buildLanes(snapshot) {
    \\  const campaignTotals = aggregateCampaigns(snapshot.campaigns?.rows);
    \\  const install = snapshot.install_funnel || {};
    \\  const installTotals = install.totals || {};
    \\  const installRates = install.rates || {};
    \\  const canonical = snapshot.canonical_funnel || {};
    \\  const canonicalStages = canonical.stages || [];
    \\  const funnel = snapshot.raw_funnel || {};
    \\  const funnelRates = funnel.rates || {};
    \\
    \\  return [
    \\    {
    \\      kicker: "distribution",
    \\      label: "Traffic to landing",
    \\      note: "native impressions not joined yet; this starts at measurable page traffic.",
    \\      steps: [
    \\        { label: "Content page sessions", value: campaignTotals.content_page_sessions },
    \\        { label: "Landing sessions", value: campaignTotals.landing_sessions },
    \\        { label: "Install copies", value: campaignTotals.install_command_copies, rate: snapshot.acquisition?.rates?.install_copy_from_landing },
    \\      ],
    \\    },
    \\    {
    \\      kicker: "setup",
    \\      label: "Install and activation prep",
    \\      note: "operator truth from install + setup telemetry.",
    \\      steps: [
    \\        { label: "Reported installs", value: installTotals.reported_installs },
    \\        { label: "CLI invoked", value: installTotals.invoked_installs, rate: installRates.invoked_from_reported_install },
    \\        { label: "Registered", value: installTotals.registered_installs, rate: funnelRates.registration_from_cli },
    \\        { label: "First success", value: installTotals.first_resolve_succeeded, rate: funnelRates.first_resolve_succeeded_from_started },
    \\      ],
    \\    },
    \\    {
    \\      kicker: "product",
    \\      label: "Canonical product funnel",
    \\      note: "registered -> activated -> aha -> repeat -> retained d7 -> retained d30.",
    \\      steps: canonicalStages.map((stage) => ({
    \\        label: stage.label,
    \\        value: stage.users,
    \\        rate: stage.conversion_from_previous,
    \\      })),
    \\    },
    \\  ];
    \\}
    \\
    \\function buildLeaks(snapshot) {
    \\  const installRates = snapshot.install_funnel?.rates || {};
    \\  const funnelRates = snapshot.raw_funnel?.rates || {};
    \\  const stages = snapshot.canonical_funnel?.stages || [];
    \\  return [
    \\    {
    \\      label: "Landing -> install copy",
    \\      note: "message match / CTA / install framing",
    \\      rate: Number(snapshot.acquisition?.rates?.install_copy_from_landing || 0),
    \\    },
    \\    {
    \\      label: "Install -> invoked",
    \\      note: "installer clarity / setup friction",
    \\      rate: Number(installRates.invoked_from_reported_install || 0),
    \\    },
    \\    {
    \\      label: "CLI -> registration",
    \\      note: "account path after local install",
    \\      rate: Number(funnelRates.registration_from_cli || 0),
    \\    },
    \\    {
    \\      label: "Registered -> first resolve start",
    \\      note: "first-run task selection",
    \\      rate: Number(funnelRates.first_resolve_started_from_registered || 0),
    \\    },
    \\    {
    \\      label: "Started -> first success",
    \\      note: "first task reliability",
    \\      rate: Number(funnelRates.first_resolve_succeeded_from_started || 0),
    \\    },
    \\    {
    \\      label: "First success -> repeat",
    \\      note: "use-case depth / habit formation",
    \\      rate: Number(funnelRates.repeat_success_from_first_success || 0),
    \\    },
    \\    {
    \\      label: "Repeat -> retained d7",
    \\      note: "product pull after early value",
    \\      rate: canonicalRate(stages, "retained_d7"),
    \\    },
    \\    {
    \\      label: "Retained d7 -> retained d30",
    \\      note: "durable workflow, not novelty",
    \\      rate: canonicalRate(stages, "retained_d30"),
    \\    },
    \\  ].sort((a, b) => a.rate - b.rate);
    \\}
    \\
    \\function renderSnapshot(snapshot) {
    \\  const lanes = buildLanes(snapshot);
    \\  lanesRoot.innerHTML = lanes.map(laneCard).join("");
    \\  leaksRoot.innerHTML = buildLeaks(snapshot).map(leakCard).join("");
    \\
    \\  const topCampaigns = (snapshot.campaigns?.rows || []).slice(0, 8);
    \\  campaignsRoot.innerHTML = topCampaigns.length
    \\    ? topCampaigns.map(campaignRow).join("")
    \\    : `<div class="empty-state">No campaign-attribution rows yet.</div>`;
    \\
    \\  const sections = (snapshot.acquisition?.sections || []).slice(0, 6);
    \\  sectionsRoot.innerHTML = sections.length
    \\    ? sections.map((item) => miniRow(item.section_id, pct(item.install_copy_rate_after_view), `${n(item.sessions)} sessions`)).join("")
    \\    : `<div class="empty-state">No section reads yet.</div>`;
    \\
    \\  const icps = (snapshot.acquisition?.dimensions?.inferred_icp || []).slice(0, 6);
    \\  icpsRoot.innerHTML = icps.length
    \\    ? icps.map((item) => miniRow(item.value, pct(item.install_copy_rate_after_view), `${n(item.sessions)} sessions`)).join("")
    \\    : `<div class="empty-state">No inferred ICPs yet.</div>`;
    \\
    \\  const warnings = [];
    \\  if (!snapshot.configured?.has_api_key) warnings.push("UNBROWSE_API_KEY missing; private analytics routes will stay empty.");
    \\  if ((snapshot.campaigns?.rows || []).length === 0) warnings.push("campaign rows empty; X-native metrics still need to be synced into the join.");
    \\  if ((snapshot.raw_funnel?.totals?.repeat_success || 0) === 0) warnings.push("repeat_success still near zero or not recorded; retention stage may be mostly instrumentation debt.");
    \\  warnings.push(...(snapshot.errors || []));
    \\  warningsRoot.innerHTML = warnings.length
    \\    ? warnings.map((warning) => `<div class="warning-row">${warning}</div>`).join("")
    \\    : `<div class="empty-state">No immediate warnings.</div>`;
    \\
    \\  const canonicalStages = snapshot.canonical_funnel?.stages || [];
    \\  const retained30 = canonicalStages.find((stage) => stage.key === "retained_d30");
    \\  summaryRoot.innerHTML = [
    \\    { label: "landing", value: aggregateCampaigns(snapshot.campaigns?.rows).landing_sessions, sub: "measured top-of-funnel" },
    \\    { label: "install copies", value: aggregateCampaigns(snapshot.campaigns?.rows).install_command_copies, sub: "promise -> intent" },
    \\    { label: "first success", value: snapshot.install_funnel?.totals?.first_resolve_succeeded || 0, sub: "setup -> value" },
    \\    { label: "retained d30", value: retained30?.users || 0, sub: "durable usage" },
    \\  ].map((item) => `
    \\    <div class="summary-card">
    \\      <div class="summary-label mono">${item.label}</div>
    \\      <div class="summary-value">${n(item.value)}</div>
    \\      <div class="summary-sub">${item.sub}</div>
    \\    </div>
    \\  `).join("");
    \\
    \\  configRoot.textContent = snapshot.configured?.has_api_key
    \\    ? `connected → ${snapshot.configured.backend_url}`
    \\    : `degraded → ${snapshot.configured?.backend_url || "backend missing"} (api key absent)`;
    \\}
    \\
    \\async function loadSnapshot() {
    \\  const days = daysSelect.value || "30";
    \\  rawLink.href = `/api/snapshot?days=${encodeURIComponent(days)}`;
    \\  configRoot.textContent = "loading snapshot…";
    \\  const response = await fetch(`/api/snapshot?days=${encodeURIComponent(days)}`);
    \\  const snapshot = await response.json();
    \\  renderSnapshot(snapshot);
    \\}
    \\
    \\daysSelect.addEventListener("change", loadSnapshot);
    \\loadSnapshot().catch((error) => {
    \\  configRoot.textContent = `snapshot failed → ${error?.message || error}`;
    \\});
    \\</script>
;

const page_css =
    \\.hero-grid { display:grid; grid-template-columns: 1fr minmax(240px, 300px); gap:18px; align-items:start; margin-bottom:18px; }
    \\.eyebrow { color: var(--accent); letter-spacing: 0.18em; text-transform: uppercase; font-size: 11px; margin-bottom: 12px; }
    \\.hero-controls { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
    \\.control { color: var(--muted); text-transform: uppercase; font-size: 11px; letter-spacing: 0.12em; }
    \\.days-select, .ghost-link {
    \\  border: 1px solid var(--line); border-radius: 999px; padding: 10px 14px; background: var(--panel-2); color: var(--text);
    \\}
    \\.ghost-link { display:inline-flex; align-items:center; }
    \\.status-card {
    \\  border: 1px solid var(--line); border-radius: 20px; min-height: 64px; padding: 16px; background: linear-gradient(180deg, rgba(255,138,61,0.16), rgba(255,255,255,0.03));
    \\  color: var(--text); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase;
    \\}
    \\.summary-strip { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:14px; margin-bottom:18px; }
    \\.summary-card { border: 1px solid var(--line); border-radius: 22px; padding: 18px; background: var(--panel); }
    \\.summary-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.16em; color: var(--muted); margin-bottom: 12px; }
    \\.summary-value { font-size: clamp(1.7rem, 2vw, 2.6rem); letter-spacing: -0.05em; }
    \\.summary-sub { color: var(--muted); margin-top: 8px; font-size: 0.92rem; }
    \\.board { display:grid; grid-template-columns: 1.7fr 0.95fr; gap:18px; }
    \\.board-main, .board-side { min-width:0; }
    \\.lanes { display:grid; gap:16px; }
    \\.lane-card { border: 1px solid var(--line); border-radius: 24px; padding: 18px; background: var(--panel); }
    \\.lane-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; margin-bottom:16px; }
    \\.lane-head h2 { margin: 4px 0 0; font-size: 1.45rem; letter-spacing: -0.04em; }
    \\.lane-head p { margin: 0; color: var(--muted); max-width: 320px; line-height: 1.45; }
    \\.lane-kicker { color: var(--accent); text-transform: uppercase; letter-spacing: 0.16em; font-size: 11px; }
    \\.lane-steps { display:grid; gap: 12px; }
    \\.lane-step-meta { display:flex; justify-content:space-between; gap: 16px; font-size: 0.95rem; margin-bottom: 6px; }
    \\.lane-step-meta span:last-child { color: var(--muted); }
    \\.lane-bar-track { height: 14px; border-radius: 999px; background: rgba(255,255,255,0.06); overflow:hidden; }
    \\.lane-bar { height:100%; border-radius:999px; background: linear-gradient(90deg, #ff8a3d, #ffc27b); }
    \\.side-card, .table-card { border: 1px solid var(--line); border-radius: 24px; padding: 18px; background: var(--panel); }
    \\.board-side { display:grid; gap:16px; align-content:start; }
    \\.table-grid { display:grid; grid-template-columns: 1.4fr 1fr; gap:18px; margin-top:18px; }
    \\.side-title { font-size: 1rem; letter-spacing: -0.02em; margin-bottom: 14px; }
    \\.stack { display:grid; gap:10px; }
    \\.stack.compact { gap:8px; }
    \\.list-row, .campaign-row {
    \\  display:flex; justify-content:space-between; align-items:flex-start; gap:14px;
    \\  padding: 12px 0; border-top: 1px solid rgba(255,255,255,0.06);
    \\}
    \\.list-row:first-child, .campaign-row:first-child { border-top: 0; padding-top: 0; }
    \\.list-title { font-size: 0.95rem; }
    \\.list-sub, .campaign-sub { color: var(--muted); margin-top: 4px; font-size: 0.83rem; line-height: 1.4; }
    \\.rate-pill {
    \\  border: 1px solid var(--line); border-radius: 999px; padding: 7px 10px; background: var(--accent-soft);
    \\  color: var(--accent); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap;
    \\}
    \\.campaign-title { font-size: 0.95rem; }
    \\.campaign-metrics { display:flex; gap: 10px; flex-wrap:wrap; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
    \\.warning-row {
    \\  border-left: 3px solid var(--danger); padding: 10px 12px; background: rgba(255, 91, 77, 0.08); color: #ffd7cf; line-height: 1.5;
    \\}
    \\.empty-state { color: var(--muted); font-size: 0.92rem; line-height: 1.5; }
    \\@media (max-width: 1100px) {
    \\  .board, .table-grid, .hero-grid, .summary-strip { grid-template-columns: 1fr; }
    \\  .lane-head { flex-direction: column; }
    \\}
;
