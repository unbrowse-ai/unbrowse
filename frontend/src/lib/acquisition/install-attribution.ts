"use client";

import {
  FIRST_TOUCH_COOKIE,
  parseAcquisitionContext,
  readNamedCookieValue,
} from "@/lib/acquisition/context";

type InstallAttribution = Record<string, string>;

function encodeBase64Utf8(value: string): string {
  if (typeof window !== "undefined" && typeof window.btoa === "function") {
    return window.btoa(unescape(encodeURIComponent(value)));
  }
  return Buffer.from(value, "utf8").toString("base64");
}

function sanitizeValue(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 160);
}

function inferPageContentType(pathname: string): string {
  if (pathname === "/") return "landing_page";
  if (pathname === "/blog") return "blog_index";
  if (pathname.startsWith("/blog/")) return "blog_article";
  if (pathname.startsWith("/compare/")) return "comparison_page";
  return "content_page";
}

function inferPageContentId(pathname: string): string {
  const normalized = pathname.replace(/^\/+|\/+$/g, "");
  return normalized ? normalized.replace(/\//g, ":") : "home";
}

function readCookieValue(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  return readNamedCookieValue(document.cookie, name);
}

export function getInstallAttributionFromDocument(): InstallAttribution | undefined {
  if (typeof document === "undefined" || typeof window === "undefined") return undefined;

  const cookieValue = readCookieValue(FIRST_TOUCH_COOKIE);
  const firstTouch = parseAcquisitionContext(cookieValue);
  const root = document.getElementById("landing-page-root");

  const attribution: InstallAttribution = {};
  for (const [key, value] of Object.entries(firstTouch ?? {})) {
    const cleaned = sanitizeValue(value);
    if (cleaned) attribution[key] = cleaned;
  }

  const variantId = sanitizeValue(root?.getAttribute("data-landing-variant-id"));
  const icp = sanitizeValue(root?.getAttribute("data-landing-icp"));
  const experimentId = sanitizeValue(root?.getAttribute("data-landing-experiment-id"));
  if (variantId) attribution.variant_id = variantId;
  if (icp) attribution.icp = icp;
  if (experimentId) attribution.experiment_id = experimentId;

  const pathname = window.location.pathname;
  attribution.content_id = attribution.content_id ?? inferPageContentId(pathname);
  attribution.content_type = attribution.content_type ?? inferPageContentType(pathname);

  return Object.keys(attribution).length > 0 ? attribution : undefined;
}

export function decorateInstallCommandWithAttribution(
  command: string,
  attribution?: InstallAttribution,
): string {
  if (!attribution || Object.keys(attribution).length === 0) return command;
  const payload = encodeBase64Utf8(JSON.stringify(attribution));

  if (command.includes("| bash")) {
    return command.replace("| bash", `| env UNBROWSE_ATTRIBUTION_B64='${payload}' bash`);
  }

  return `env UNBROWSE_ATTRIBUTION_B64='${payload}' ${command}`;
}
