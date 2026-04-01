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
