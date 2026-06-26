#!/usr/bin/env bun
import { lookup } from "node:dns/promises";
import { connect } from "node:tls";
import { spawnSync } from "node:child_process";
import { fetchDirectDocument } from "../../src/orchestrator/direct-document.js";
import { resolveProxyUrl } from "../../src/execution/proxy-fetch.js";
import { tryCurlImpersonateFetch } from "../../src/capture/curl-impersonate-fallback.js";

type LayerStatus = "pass" | "fail" | "skip";

interface LayerRow {
  layer: string;
  status: LayerStatus;
  detail: Record<string, unknown>;
}

interface TargetReport {
  url: string;
  intent: string;
  layers: LayerRow[];
  holes: Array<{ layer: string; reason: string }>;
}

const targets = [
  {
    url: process.env.UNBROWSE_LAYER_URL ?? "https://docs.redhat.com/es/documentation/red_hat_jboss_enterprise_application_platform/7.4/html-single/developing_hibernate_applications/index",
    intent: process.env.UNBROWSE_LAYER_INTENT ?? "document contents",
  },
  {
    url: "https://requests.readthedocs.io/en/latest/",
    intent: "document contents",
  },
];

const timeoutMs = Number(process.env.UNBROWSE_LAYER_TIMEOUT_MS ?? "25000") || 25_000;

function row(layer: string, status: LayerStatus, detail: Record<string, unknown> = {}): LayerRow {
  return { layer, status, detail };
}

function classifyHole(layer: string, detail: Record<string, unknown>): { layer: string; reason: string } | null {
  if (layer === "curl_impersonate_proxy" && detail.skipped === "proxy_creds_missing") return null;
  if (layer === "native_fetch" && typeof detail.status === "number" && detail.status >= 400) return null;
  if (layer === "direct_document" && detail.reason === "rejected_or_empty") return { layer, reason: "direct document could not produce a usable page" };
  if (layer === "unbrowse_search") {
    const source = String(detail.source ?? "");
    const markdownBytes = Number(detail.markdown_bytes ?? 0);
    if (source !== "direct-document" || markdownBytes < 500) {
      return { layer, reason: `CLI did not fold to a direct-document value (source=${source || "unknown"}, markdown_bytes=${markdownBytes})` };
    }
  }
  if (String(detail.error ?? "").length > 0) return { layer, reason: String(detail.error) };
  return null;
}

async function tcpTls(url: URL): Promise<LayerRow> {
  return await new Promise((resolve) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname, timeout: 8_000 }, () => {
      const authorized = socket.authorized;
      const protocol = socket.getProtocol();
      socket.destroy();
      resolve(row("tcp_tls", authorized ? "pass" : "fail", { authorized, protocol }));
    });
    socket.on("timeout", () => { socket.destroy(); resolve(row("tcp_tls", "fail", { error: "timeout" })); });
    socket.on("error", (err) => resolve(row("tcp_tls", "fail", { error: err.message })));
  });
}

async function nativeFetch(url: string): Promise<LayerRow> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "unbrowse/1.0", "Accept": "text/html,application/json;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    return row("native_fetch", res.ok ? "pass" : "fail", {
      status: res.status,
      content_type: res.headers.get("content-type") ?? "",
      bytes: text.length,
    });
  } catch (err) {
    return row("native_fetch", "fail", { error: err instanceof Error ? err.message : String(err) });
  }
}

async function curlLayer(url: string, proxy: boolean): Promise<LayerRow> {
  const proxyUrl = proxy ? resolveProxyUrl() : undefined;
  if (proxy && !proxyUrl) return row("curl_impersonate_proxy", "skip", { skipped: "proxy_creds_missing" });
  try {
    const res = await tryCurlImpersonateFetch({
      url,
      impersonate: "chrome131",
      timeoutMs,
      ...(proxy ? { proxy: proxyUrl } : { forceDirect: true }),
    });
    return row(proxy ? "curl_impersonate_proxy" : "curl_impersonate_direct", res && res.status >= 200 && res.status < 400 ? "pass" : "fail", {
      status: res?.status ?? 0,
      bytes: res?.bytes ?? 0,
      proxy_used: res?.proxy_used ?? false,
      final_url: res?.final_url ?? url,
    });
  } catch (err) {
    return row(proxy ? "curl_impersonate_proxy" : "curl_impersonate_direct", "fail", { error: err instanceof Error ? err.message : String(err) });
  }
}

async function directDocument(url: string): Promise<LayerRow> {
  const doc = await fetchDirectDocument(url);
  return row("direct_document", doc ? "pass" : "fail", {
    reason: doc ? "served" : "rejected_or_empty",
    markdown_bytes: doc?.markdown?.length ?? 0,
    html_bytes: doc?.html_bytes ?? 0,
    url_template: doc?.url_template ?? "",
  });
}

function unbrowseSearch(url: string, intent: string): LayerRow {
  const bin = process.env.UNBROWSE_BIN?.trim() || "unbrowse";
  const prefixArgs = (process.env.UNBROWSE_BIN_ARGS ?? "").trim().split(/\s+/).filter(Boolean);
  const proc = spawnSync(bin, [...prefixArgs, "search", "--intent", intent, "--url", url, "--budget", "40000"], {
    encoding: "utf8",
    timeout: 80_000,
    env: { ...process.env, UNBROWSE_MARKDOWN_BUDGET: process.env.UNBROWSE_MARKDOWN_BUDGET ?? "200000" },
  });
  let source = "";
  let markdownBytes = 0;
  for (const line of proc.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, any>;
      if (obj && typeof obj.result === "object") {
        source = String(obj.source ?? "");
        markdownBytes = String(obj.result.markdown ?? "").length;
      }
    } catch {
      // ignore non-result logs
    }
  }
  return row("unbrowse_search", proc.status === 0 && Boolean(source) ? "pass" : "fail", {
    rc: proc.status,
    bin,
    bin_args: prefixArgs.join(" "),
    source,
    markdown_bytes: markdownBytes,
    stderr: proc.stderr.slice(0, 300),
  });
}

async function inspectTarget(target: { url: string; intent: string }): Promise<TargetReport> {
  const url = new URL(target.url);
  const layers: LayerRow[] = [];
  try {
    const addresses = await lookup(url.hostname, { all: true });
    layers.push(row("dns", addresses.length > 0 ? "pass" : "fail", { addresses: addresses.slice(0, 4).map((a) => a.address) }));
  } catch (err) {
    layers.push(row("dns", "fail", { error: err instanceof Error ? err.message : String(err) }));
  }
  layers.push(await tcpTls(url));
  layers.push(await nativeFetch(target.url));
  layers.push(await curlLayer(target.url, false));
  layers.push(await curlLayer(target.url, true));
  layers.push(await directDocument(target.url));
  layers.push(unbrowseSearch(target.url, target.intent));
  const holes = layers.flatMap((l) => {
    if (l.status === "skip") return [];
    const hole = classifyHole(l.layer, l.detail);
    return hole ? [hole] : [];
  });
  return { ...target, layers, holes };
}

const reports = [];
for (const target of targets) reports.push(await inspectTarget(target));
const ok = reports.every((r) => r.holes.length === 0);
console.log(JSON.stringify({ ts: new Date().toISOString(), ok, reports }, null, 2));
process.exit(ok ? 0 : 1);
