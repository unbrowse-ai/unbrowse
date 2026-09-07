// ---------------------------------------------------------------------------
// Search-ROUTE discovery — the page defines its own search pipe via its links.
// ---------------------------------------------------------------------------
// A JS-SPA search box is often not a <form> (so detectSearchForms misses it),
// but the site still exposes its search/listing route in its OWN links: a
// repeated sibling-link pattern where exactly ONE path segment varies across
// many links is a parameterized search route — the {query} hole. Carousell's
// homepage links /jbl/q/, /garmin/q/, /portable-aircon/q/ → "/{query}/q/"; fill
// {query}=food → /food/q/ (the food listing). This is the pipe "all the way
// down": entry page → search-route hole → listing collection → item pointers.
// General + structural (CLAUDE.md "never a hard filter"): no per-site allowlist,
// no keyword list — the page's link structure defines the pipe; the agent judges
// which template + fills the query.

export interface SearchRouteTemplate {
  /** Path with exactly one `{query}` hole, e.g. `/{query}/q/` or `/search/{query}`. */
  template: string;
  /** Example query values observed in the varying slot (evidence for the judge). */
  samples: string[];
  /** Distinct values seen in the slot — the confidence that this is a search route. */
  count: number;
}

/** Derive search/listing ROUTE templates from a page's own links. Groups links by
 *  shape with one segment masked to `{query}`; a shape with many DISTINCT
 *  query-like values in that slot is a search route. Returns highest-confidence
 *  first. Pure over the HTML — no network, no allowlist. */
export function deriveSearchRouteTemplates(html: string, minDistinct = 4): SearchRouteTemplate[] {
  const hrefs = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["'](\/[^"'?#\s]+)["']/gi)) hrefs.add(m[1]);
  const groups = new Map<string, Set<string>>();
  for (const h of hrefs) {
    const segs = h.split("/").filter(Boolean);
    if (segs.length < 1 || segs.length > 4) continue;
    for (let i = 0; i < segs.length; i++) {
      const val = segs[i];
      // The varying slot must look like a query token (word/slug) — not an id
      // (those are entity-detail pointers, a different pipe) and not a file.
      if (!/^[a-z][a-z0-9-]{1,40}$/i.test(val) || /\d{3,}/.test(val) || /\.[a-z0-9]{1,5}$/i.test(val)) continue;
      const shape = segs.map((s, j) => (j === i ? "{query}" : s)).join("/");
      const trailing = h.endsWith("/") ? "/" : "";
      const key = `/${shape}${trailing}`;
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key)!.add(val.toLowerCase());
    }
  }
  const out: SearchRouteTemplate[] = [];
  for (const [template, vals] of groups) {
    if (vals.size >= minDistinct) out.push({ template, samples: [...vals].slice(0, 5), count: vals.size });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** Fill a derived search-route template's `{query}` hole against an origin. */
export function fillSearchRoute(origin: string, template: string, query: string): string {
  const slug = encodeURIComponent(query.trim().toLowerCase());
  return origin.replace(/\/+$/, "") + template.replace("{query}", slug);
}

export interface SearchFormField {
  name: string;
  type: "text" | "select" | "radio" | "checkbox" | "date" | "hidden";
  selector: string;
  options?: string[];
  required: boolean;
}

export interface SearchFormSpec {
  form_selector: string;
  submit_selector: string;
  fields: SearchFormField[];
  result_selector?: string;
}

export function isStructuredSearchForm(spec: SearchFormSpec): boolean {
  return spec.fields.length > 0 && !!spec.submit_selector;
}

// ---------------------------------------------------------------------------
// HTML detection — parse raw HTML to discover search forms
// ---------------------------------------------------------------------------

const SEARCH_FIELD_NAMES = new Set([
  "q", "query", "search", "keyword", "keywords", "term", "terms",
  "find", "lookup", "filter", "s", "text", "input",
]);

const LOGIN_FIELD_NAMES = new Set([
  "password", "passwd", "pass", "pwd", "confirm_password",
  "username", "email", "login", "user",
]);

const SUPPORTED_INPUT_TYPES = new Set([
  "text", "search", "hidden", "date", "number", "tel", "email",
]);

function formSelectorFromElement(
  attribs: Record<string, string>,
  index: number,
): string {
  const id = attribs.id;
  if (id) return `form#${id}`;
  const name = attribs.name;
  if (name) return `form[name="${name}"]`;
  const action = attribs.action;
  if (action) return `form[action="${action}"]`;
  return `form:nth-of-type(${index + 1})`;
}

function inputSelectorFromElement(
  attribs: Record<string, string>,
  tagName: string,
): string {
  const id = attribs.id;
  if (id) return `#${id}`;
  const name = attribs.name;
  if (name) return `${tagName}[name="${name}"]`;
  return tagName;
}

function mapInputType(
  typeAttr: string | undefined,
  tagName: string,
): SearchFormField["type"] | null {
  if (tagName === "select") return "select";
  if (tagName === "textarea") return "text";
  const t = (typeAttr ?? "text").toLowerCase();
  if (t === "radio") return "radio";
  if (t === "checkbox") return "checkbox";
  if (t === "date") return "date";
  if (t === "hidden") return "hidden";
  if (t === "submit" || t === "button" || t === "image" || t === "reset") return null;
  if (t === "password" || t === "file") return null;
  if (SUPPORTED_INPUT_TYPES.has(t)) return "text";
  return "text";
}

function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /(\w[\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(attrStr)) !== null) {
    attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

/**
 * Detect structured search forms from raw HTML.
 * Returns a SearchFormSpec for each form that looks like a search/filter form
 * (has at least one search-like field and a submit mechanism).
 * Login/password forms are excluded.
 */
export function detectSearchForms(html: string): SearchFormSpec[] {
  const results: SearchFormSpec[] = [];
  const formRegex = /<form([^>]*)>([\s\S]*?)<\/form>/gi;
  let formMatch: RegExpExecArray | null;
  let formIndex = 0;

  while ((formMatch = formRegex.exec(html)) !== null) {
    const formAttrs = formMatch[1];
    const formBody = formMatch[2];

    const formElAttrs = parseAttrs(formAttrs);

    // Find all input/select/textarea elements
    const fieldRegex = /<(input|select|textarea)([^>]*)\/?>/gi;
    let fieldMatch: RegExpExecArray | null;
    const fields: SearchFormField[] = [];
    const seenNames = new Set<string>();
    let hasLoginField = false;
    let hasSearchLikeField = false;

    while ((fieldMatch = fieldRegex.exec(formBody)) !== null) {
      const tagName = fieldMatch[1].toLowerCase();
      const fieldAttrs = parseAttrs(fieldMatch[2]);
      const name = fieldAttrs.name ?? "";
      const typeAttr = fieldAttrs.type;

      // Check for login-form indicators
      if (LOGIN_FIELD_NAMES.has(name.toLowerCase()) || typeAttr === "password") {
        hasLoginField = true;
      }

      // Check for search-like fields
      if (SEARCH_FIELD_NAMES.has(name.toLowerCase())) {
        hasSearchLikeField = true;
      }

      const mappedType = mapInputType(typeAttr, tagName);
      if (!mappedType) continue;
      if (!name && mappedType !== "text") continue;
      if (seenNames.has(name) && mappedType !== "radio") continue;
      if (name) seenNames.add(name);

      // Collect select options
      let options: string[] | undefined;
      if (tagName === "select") {
        const optRegex = /<option[^>]*value="([^"]*)"[^>]*>/gi;
        let optMatch: RegExpExecArray | null;
        options = [];
        while ((optMatch = optRegex.exec(formBody)) !== null) {
          options.push(optMatch[1]);
        }
        if (options.length === 0) options = undefined;
      }

      fields.push({
        name: name || `unnamed_${fields.length}`,
        type: mappedType,
        selector: inputSelectorFromElement(fieldAttrs, tagName),
        ...(options ? { options } : {}),
        required: fieldAttrs.required !== undefined,
      });
    }

    // Detect submit mechanism
    let submitSelector = "";
    if (/<button[^>]*type\s*=\s*"submit"/i.test(formBody)) {
      submitSelector = "button[type=submit]";
    } else if (/<input[^>]*type\s*=\s*"submit"/i.test(formBody)) {
      submitSelector = 'input[type="submit"]';
    } else if (/<button/i.test(formBody)) {
      submitSelector = "button";
    }

    // Skip login forms, require at least one meaningful field
    const nonHiddenFields = fields.filter((f) => f.type !== "hidden");
    if (
      !hasLoginField &&
      nonHiddenFields.length > 0 &&
      submitSelector &&
      (hasSearchLikeField || nonHiddenFields.length >= 1)
    ) {
      const formSelector = formSelectorFromElement(formElAttrs, formIndex);
      results.push({
        form_selector: formSelector,
        submit_selector: submitSelector,
        fields,
      });
    }

    formIndex++;
  }

  return results;
}
