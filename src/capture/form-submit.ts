import { load } from "cheerio";

type CapturedCookie = {
  name: string;
  value: string;
  domain: string;
};

export type SubmittedHtmlFormResult = {
  final_url: string;
  html?: string;
  request: {
    url: string;
    method: string;
    request_headers: Record<string, string>;
    request_body?: string;
    response_status: number;
    response_headers: Record<string, string>;
    response_body?: string;
    timestamp: string;
  };
};

export type FetchedHtmlDocument = {
  final_url: string;
  html?: string;
  status: number;
  headers: Record<string, string>;
};

export type InferredHtmlActionForm = {
  url: string;
  method: "POST";
  headers_template: Record<string, string>;
  body: Record<string, unknown>;
};

function hostMatchesCookieDomain(host: string, cookieDomain: string): boolean {
  const normalized = cookieDomain.replace(/^\./, "").toLowerCase();
  const target = host.toLowerCase();
  return target === normalized || target.endsWith(`.${normalized}`);
}

function buildCookieHeader(cookies: CapturedCookie[], targetUrl: string): string | undefined {
  let hostname = "";
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    return undefined;
  }
  const matched = cookies
    .filter((cookie) => hostMatchesCookieDomain(hostname, cookie.domain))
    .map((cookie) => {
      const value = cookie.value.startsWith("\"") && cookie.value.endsWith("\"")
        ? cookie.value.slice(1, -1)
        : cookie.value;
      return `${cookie.name}=${value}`;
    });
  return matched.length > 0 ? matched.join("; ") : undefined;
}

function scoreQueryField(attrs: {
  name?: string;
  id?: string;
  placeholder?: string;
  ariaLabel?: string;
  type?: string;
}): number {
  const haystack = [
    attrs.name,
    attrs.id,
    attrs.placeholder,
    attrs.ariaLabel,
    attrs.type,
  ].filter(Boolean).join(" ").toLowerCase();
  let score = 0;
  if (/search|query|keyword|find|lookup|term/.test(haystack)) score += 10;
  if (/case|citation|title/.test(haystack)) score += 4;
  if (attrs.type === "search") score += 6;
  if (attrs.type === "text") score += 2;
  return score;
}

function appendField(params: URLSearchParams, name: string, value: string): void {
  params.append(name, value);
}

function encodeFormBody(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null) appendField(params, key, String(item));
      }
      continue;
    }
    appendField(params, key, String(value));
  }
  return params.toString();
}

function normalizeBindingKey(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[.[\]]+/g, "_")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function actionIntentTerms(intent: string | undefined): string[] {
  const lower = intent?.toLowerCase() ?? "";
  const terms: string[] = [];
  if (/\brsvp\b/.test(lower)) terms.push("rsvp");
  if (/\bregister\b/.test(lower)) terms.push("register");
  if (/\bjoin\b/.test(lower)) terms.push("join");
  if (/\bapply\b/.test(lower)) terms.push("apply");
  if (/\bsign\s*up\b|\bsignup\b/.test(lower)) terms.push("sign up", "signup");
  if (/\bbook\b/.test(lower)) terms.push("book");
  if (/\breserve\b/.test(lower)) terms.push("reserve");
  if (/\bcheckout\b/.test(lower)) terms.push("checkout");
  if (/\bpurchase\b/.test(lower)) terms.push("purchase");
  if (/\border\b/.test(lower)) terms.push("order");
  return [...new Set(terms)];
}

function isActionPlaceholderField(attrs: {
  name?: string;
  id?: string;
  placeholder?: string;
  ariaLabel?: string;
  type?: string;
  required?: boolean;
}): boolean {
  const haystack = [
    attrs.name,
    attrs.id,
    attrs.placeholder,
    attrs.ariaLabel,
    attrs.type,
  ].filter(Boolean).join(" ").toLowerCase();
  if (attrs.required) return true;
  return /(email|name|first|last|company|phone|message|note|comment|quantity|qty|size|ticket|code|answer)/.test(haystack);
}

export function inferLikelyHtmlActionForm(options: {
  html: string;
  pageUrl: string;
  intent?: string;
}): InferredHtmlActionForm | null {
  const actionTerms = actionIntentTerms(options.intent);
  if (!options.html || actionTerms.length === 0) return null;

  const $ = load(options.html);
  let best:
    | {
      url: string;
      method: "POST";
      headers_template: Record<string, string>;
      body: Record<string, unknown>;
      score: number;
    }
    | null = null;

  $("form").each((_, formEl) => {
    const form = $(formEl);
    const action = form.attr("action") || options.pageUrl;
    let actionUrl = options.pageUrl;
    try {
      actionUrl = new URL(action, options.pageUrl).toString();
    } catch {
      return;
    }
    const method = (form.attr("method") || "GET").toUpperCase();
    if (method !== "POST") return;
    const enctype = (form.attr("enctype") || "application/x-www-form-urlencoded").toLowerCase();
    if (/multipart\/form-data/.test(enctype)) return;

    const body: Record<string, unknown> = {};
    let score = 0;
    let hasPasswordField = false;
    let fieldCount = 0;
    let placeholderCount = 0;
    let submitSignal = "";

    form.find("button, input, textarea, select").each((__, fieldEl) => {
      const field = $(fieldEl);
      const tagName = fieldEl.tagName?.toLowerCase() ?? "";
      const name = field.attr("name");
      const id = field.attr("id");
      const placeholder = field.attr("placeholder");
      const ariaLabel = field.attr("aria-label");

      if (tagName === "button") {
        submitSignal += ` ${field.text()} ${name ?? ""} ${field.attr("value") ?? ""}`;
        if (name) {
          const value = field.attr("value");
          if (value) body[name] = value;
        }
        return;
      }

      if (!name) return;
      const type = (field.attr("type") || (tagName === "textarea" ? "textarea" : "text")).toLowerCase();
      const required = field.attr("required") != null;
      if (type === "password") {
        hasPasswordField = true;
        return;
      }
      if (type === "submit" || type === "button" || type === "image" || type === "reset" || type === "file") {
        submitSignal += ` ${name} ${field.attr("value") ?? ""}`;
        const value = field.attr("value");
        if (value && !body[name]) body[name] = value;
        return;
      }

      fieldCount += 1;

      if (tagName === "select") {
        const selected = field.find("option[selected]").first();
        const fallback = selected.length > 0 ? selected : field.find("option").first();
        const value = fallback.attr("value") ?? fallback.text().trim();
        if (value) body[name] = value;
        return;
      }

      if ((type === "checkbox" || type === "radio") && field.attr("checked") == null) return;

      const value = tagName === "textarea" ? field.text().trim() : (field.attr("value") ?? "");
      if (value) {
        const existing = body[name];
        if (existing == null) body[name] = value;
        else if (Array.isArray(existing)) existing.push(value);
        else body[name] = [existing, value];
        return;
      }

      if (isActionPlaceholderField({ name, id, placeholder, ariaLabel, type, required })) {
        const binding = normalizeBindingKey(name || id || placeholder || ariaLabel || "value");
        body[name] = `{${binding || "value"}}`;
        placeholderCount += 1;
      }
    });

    const text = `${form.text()} ${submitSignal} ${actionUrl}`.toLowerCase();
    if (hasPasswordField || /\blogin\b|\bsign in\b|\bsignin\b|\bpassword\b|\blog out\b|\blogout\b/.test(text)) return;

    for (const term of actionTerms) {
      if (text.includes(term)) score += 12;
    }
    if (/\/(api|graphql|rpc)\//.test(actionUrl.toLowerCase())) score += 10;
    if (/(register|rsvp|join|apply|signup|book|reserve|checkout|purchase|order)/.test(actionUrl.toLowerCase())) score += 14;
    if (placeholderCount > 0) score += 6;
    if (/\bemail\b/.test(text)) score += 4;
    if (fieldCount === 0) score -= 8;
    if (Object.keys(body).length === 0) return;
    if (score <= 0) return;

    const candidate = {
      url: actionUrl,
      method: "POST" as const,
      headers_template: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      score,
    };
    if (!best || candidate.score > best.score) best = candidate;
  });

  return best
    ? {
        url: best.url,
        method: best.method,
        headers_template: best.headers_template,
        body: best.body,
      }
    : null;
}

export async function fetchHtmlDocument(options: {
  url: string;
  authHeaders?: Record<string, string>;
  cookies?: CapturedCookie[];
  referer?: string;
}): Promise<FetchedHtmlDocument | null> {
  const headers: Record<string, string> = {
    accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    ...options.authHeaders,
  };
  const cookieHeader = buildCookieHeader(options.cookies ?? [], options.url);
  if (cookieHeader && !headers.cookie) headers.cookie = cookieHeader;

  try {
    const target = new URL(options.url);
    headers.referer ??= options.referer ?? options.url;
    headers.origin ??= target.origin;
  } catch {
    return null;
  }

  const response = await fetch(options.url, {
    method: "GET",
    headers,
    redirect: "follow",
  });

  const responseText = await response.text();
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const contentType = response.headers.get("content-type") ?? "";

  return {
    final_url: response.url || options.url,
    html: /html|xhtml/i.test(contentType) ? responseText : undefined,
    status: response.status,
    headers: responseHeaders,
  };
}

export async function submitLikelyHtmlSearchForm(options: {
  html: string;
  pageUrl: string;
  query: string;
  authHeaders?: Record<string, string>;
  cookies?: CapturedCookie[];
}): Promise<SubmittedHtmlFormResult | null> {
  const { html, pageUrl, query } = options;
  if (!html || !query.trim()) return null;

  const $ = load(html);
  let best:
    | {
      actionUrl: string;
      method: "GET" | "POST";
      body: Record<string, unknown>;
      score: number;
    }
    | null = null;

  $("form").each((_, formEl) => {
    const form = $(formEl);
    const action = form.attr("action") || pageUrl;
    let actionUrl = pageUrl;
    try {
      actionUrl = new URL(action, pageUrl).toString();
    } catch {
      return;
    }
    const method = (form.attr("method") || "GET").toUpperCase() === "POST" ? "POST" : "GET";
    const body: Record<string, unknown> = {};
    let score = 0;
    let queryFieldName: string | null = null;
    let queryFieldScore = -1;
    let hasPasswordField = false;
    let submitChoiceCount = 0;
    let hasBrowseControl = false;

    form.find("input, textarea, select").each((__, fieldEl) => {
      const field = $(fieldEl);
      const tagName = fieldEl.tagName?.toLowerCase() ?? "";
      const name = field.attr("name");
      if (!name) return;

      if (tagName === "select") {
        const selected = field.find("option[selected]").first();
        const fallback = selected.length > 0 ? selected : field.find("option").first();
        const value = fallback.attr("value") ?? fallback.text().trim();
        if (value) body[name] = value;
        return;
      }

      if (tagName === "textarea") {
        const current = field.text().trim();
        body[name] = current;
        const fieldScore = scoreQueryField({
          name,
          id: field.attr("id"),
          placeholder: field.attr("placeholder"),
          ariaLabel: field.attr("aria-label"),
          type: "textarea",
        });
        if (fieldScore > queryFieldScore) {
          queryFieldScore = fieldScore;
          queryFieldName = name;
        }
        return;
      }

      const type = (field.attr("type") || "text").toLowerCase();
      if (type === "password") {
        hasPasswordField = true;
        return;
      }
      if (type === "submit" || type === "button" || type === "image" || type === "file" || type === "reset") {
        submitChoiceCount += 1;
        const submitSignal = `${name ?? ""} ${field.attr("value") ?? ""}`.toLowerCase();
        if (/\bbrowse\b|\bcatelog\b/.test(submitSignal) || /^[a-z]$/.test((field.attr("value") ?? "").toLowerCase())) {
          hasBrowseControl = true;
        }
        return;
      }

      if ((type === "checkbox" || type === "radio") && field.attr("checked") == null) return;

      const fieldScore = scoreQueryField({
        name,
        id: field.attr("id"),
        placeholder: field.attr("placeholder"),
        ariaLabel: field.attr("aria-label"),
        type,
      });
      if (fieldScore > queryFieldScore) {
        queryFieldScore = fieldScore;
        queryFieldName = name;
      }

      const value = field.attr("value") ?? "";
      const existing = body[name];
      if (existing == null) {
        body[name] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        body[name] = [existing, value];
      }
    });

    if (queryFieldName) {
      body[queryFieldName] = query;
      score += 12 + Math.max(queryFieldScore, 0);
      if (/basicsearchkey/i.test(queryFieldName)) score += 14;
    }

    const submitText = form.find("button, input[type='submit'], a").text().toLowerCase();
    const authSignals = `${actionUrl} ${submitText} ${form.text()}`.toLowerCase();
    if (hasPasswordField || /\blogin\b|\bsign in\b|\bsignin\b|\bpassword\b|\blog out\b|\blogout\b/.test(authSignals)) return;
    if (queryFieldScore < 6) return;
    if (/search|find|lookup|submit/.test(submitText)) score += 6;
    if (/result-page|searchresult|basicseachactionurl|basicsearchactionurl/.test(actionUrl.toLowerCase())) score += 24;
    if (/search|result|lookup|find/.test(actionUrl.toLowerCase())) score += 4;
    if (submitChoiceCount >= 6) score -= 10;
    if (hasBrowseControl) score -= 18;
    if (Object.keys(body).length >= 2) score += 2;

    if (!queryFieldName || score <= 0) return;
    if (!best || score > best.score) {
      best = { actionUrl, method, body, score };
    }
  });

  if (!best) return null;

  const headers: Record<string, string> = {
    accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    ...options.authHeaders,
  };
  const cookieHeader = buildCookieHeader(options.cookies ?? [], best.actionUrl);
  if (cookieHeader && !headers.cookie) headers.cookie = cookieHeader;

  try {
    const target = new URL(best.actionUrl);
    headers.referer ??= pageUrl;
    headers.origin ??= target.origin;
  } catch {
    // ignore
  }

  let requestUrl = best.actionUrl;
  let requestBody: string | undefined;
  if (best.method === "GET") {
    const url = new URL(best.actionUrl);
    for (const [key, value] of Object.entries(best.body)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    requestUrl = url.toString();
  } else {
    requestBody = encodeFormBody(best.body);
    headers["content-type"] ??= "application/x-www-form-urlencoded";
  }

  const response = await fetch(requestUrl, {
    method: best.method,
    headers,
    ...(requestBody ? { body: requestBody } : {}),
    redirect: "follow",
  });

  const responseText = await response.text();
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const contentType = response.headers.get("content-type") ?? "";

  return {
    final_url: response.url || requestUrl,
    html: /html|xhtml/i.test(contentType) ? responseText : undefined,
    request: {
      url: requestUrl,
      method: best.method,
      request_headers: headers,
      ...(requestBody ? { request_body: requestBody } : {}),
      response_status: response.status,
      response_headers: responseHeaders,
      response_body: responseText,
      timestamp: new Date().toISOString(),
    },
  };
}
