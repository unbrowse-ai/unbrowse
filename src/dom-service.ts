/**
 * DOM Element Extraction — browser-use-inspired element indexing for LLM consumption.
 *
 * Injects JavaScript into a Playwright page to:
 *   1. Find all interactive elements (links, buttons, inputs, selects, textareas, etc.)
 *   2. Assign each a numeric index (starting at 1)
 *   3. Return structured metadata (tag, text, type, placeholder, href, value, role, options)
 *   4. Provide a way to interact with elements by index
 *
 * Ported from the browser-use Python library's DOM service concept.
 */

export interface IndexedElement {
  index: number;
  tag: string;
  type?: string;       // input type (text, email, password, checkbox, radio, submit, etc.)
  role?: string;       // ARIA role
  text: string;        // visible text / label
  placeholder?: string;
  href?: string;       // for links
  value?: string;      // current value
  name?: string;       // form field name
  ariaLabel?: string;
  options?: string[];  // for <select> elements — first 10 option labels
  isVisible: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface PageState {
  url: string;
  title: string;
  elements: IndexedElement[];
  scrollPosition: { x: number; y: number };
  scrollHeight: number;
  viewportHeight: number;
  /** Short text representation for LLM context (element list) */
  elementTree: string;
}

/**
 * The JavaScript injected into the page to extract interactive elements.
 * Self-contained IIFE — no external dependencies.
 */
const EXTRACTION_JS = `(() => {
  const INTERACTIVE_SELECTORS = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="option"]',
    '[role="textbox"]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
    'summary',
    'details',
    'label[for]',
  ];

  const seen = new Set();
  const elements = [];
  let index = 1;

  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
      // Fixed/sticky elements have null offsetParent but are visible
      const style = getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
    return true;
  }

  function getText(el) {
    // For inputs, use placeholder or aria-label
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return el.placeholder || el.getAttribute('aria-label') || el.name || '';
    }
    // For buttons/links, get direct text content (avoid deep nesting noise)
    const text = el.innerText || el.textContent || '';
    return text.trim().slice(0, 200);
  }

  function getOptions(el) {
    if (el.tagName !== 'SELECT') return undefined;
    const opts = [];
    for (let i = 0; i < Math.min(el.options.length, 10); i++) {
      opts.push(el.options[i].text.trim().slice(0, 80));
    }
    if (el.options.length > 10) {
      opts.push('... ' + (el.options.length - 10) + ' more');
    }
    return opts;
  }

  // Query all interactive elements
  const allEls = document.querySelectorAll(INTERACTIVE_SELECTORS.join(','));

  for (const el of allEls) {
    // Deduplicate (an element might match multiple selectors)
    if (seen.has(el)) continue;
    seen.add(el);

    const vis = isVisible(el);
    // Skip hidden elements (but include hidden inputs like CSRF tokens)
    if (!vis && el.tagName !== 'INPUT') continue;
    // Skip inputs that are truly hidden (type=hidden)
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue;

    const rect = el.getBoundingClientRect();

    const entry = {
      index: index++,
      tag: el.tagName.toLowerCase(),
      type: el.type || undefined,
      role: el.getAttribute('role') || undefined,
      text: getText(el),
      placeholder: el.placeholder || undefined,
      href: el.tagName === 'A' ? el.getAttribute('href') : undefined,
      value: (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')
        ? (el.value || undefined)
        : undefined,
      name: el.name || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      options: getOptions(el),
      isVisible: vis,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    };

    elements.push(entry);
  }

  // Also detect click-handler elements (divs/spans with onclick or pointer cursor)
  // that aren't caught by the selector list
  const allClickable = document.querySelectorAll('[onclick], [data-action], [data-click]');
  for (const el of allClickable) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!isVisible(el)) continue;

    const rect = el.getBoundingClientRect();
    elements.push({
      index: index++,
      tag: el.tagName.toLowerCase(),
      type: undefined,
      role: el.getAttribute('role') || 'button',
      text: getText(el),
      placeholder: undefined,
      href: undefined,
      value: undefined,
      name: undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      options: undefined,
      isVisible: true,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    });
  }

  return {
    url: location.href,
    title: document.title,
    elements: elements,
    scrollPosition: { x: window.scrollX, y: window.scrollY },
    scrollHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
  };
})()`;

/**
 * Extract all interactive elements from a Playwright page, indexed for LLM use.
 */
export async function extractPageState(page: any): Promise<PageState> {
  const raw = await page.evaluate(EXTRACTION_JS);

  const elements: IndexedElement[] = raw.elements;

  // Build element tree text representation (like browser-use's serialized DOM)
  const lines: string[] = [];
  for (const el of elements) {
    if (!el.isVisible) continue;

    let desc = `[${el.index}] <${el.tag}`;
    if (el.type && el.tag === "input") desc += ` type="${el.type}"`;
    if (el.role) desc += ` role="${el.role}"`;
    if (el.name) desc += ` name="${el.name}"`;
    if (el.ariaLabel) desc += ` aria-label="${el.ariaLabel}"`;
    if (el.placeholder) desc += ` placeholder="${el.placeholder}"`;
    if (el.href) desc += ` href="${el.href.slice(0, 80)}"`;
    if (el.value) desc += ` value="${el.value.slice(0, 50)}"`;
    desc += ">";
    if (el.text) desc += ` ${el.text.slice(0, 100)}`;
    if (el.options) desc += ` options=[${el.options.join(", ")}]`;

    lines.push(desc);
  }

  return {
    url: raw.url,
    title: raw.title,
    elements,
    scrollPosition: raw.scrollPosition,
    scrollHeight: raw.scrollHeight,
    viewportHeight: raw.viewportHeight,
    elementTree: lines.join("\n"),
  };
}

/**
 * Build a CSS selector that targets an element by its extraction index.
 * We inject a data attribute during extraction so we can find it again.
 *
 * Since we can't modify the extraction JS to tag elements (it runs read-only),
 * we use nth-match approach: re-query with the same selector list and pick
 * the element at the right offset.
 */
const INTERACT_BY_INDEX_JS = `(index) => {
  const INTERACTIVE_SELECTORS = [
    'a[href]', 'button', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="tab"]',
    '[role="menuitem"]', '[role="checkbox"]', '[role="radio"]',
    '[role="switch"]', '[role="combobox"]', '[role="listbox"]',
    '[role="option"]', '[role="textbox"]',
    '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
    'summary', 'details', 'label[for]',
    '[onclick]', '[data-action]', '[data-click]',
  ];

  const seen = new Set();
  let i = 1;

  const allEls = document.querySelectorAll(INTERACTIVE_SELECTORS.join(','));
  for (const el of allEls) {
    if (seen.has(el)) continue;
    seen.add(el);

    const tagName = el.tagName;
    // Skip hidden (same logic as extraction)
    if (tagName === 'INPUT' && el.type === 'hidden') continue;
    if (!el.offsetParent && tagName !== 'BODY' && tagName !== 'HTML') {
      const style = getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') {
        if (tagName !== 'INPUT') continue;
      }
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && tagName !== 'INPUT') continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') {
      if (tagName !== 'INPUT') continue;
    }

    if (i === index) return el;
    i++;
  }
  return null;
}`;

/**
 * Get a Playwright ElementHandle by extraction index.
 */
export async function getElementByIndex(page: any, index: number): Promise<any | null> {
  return page.evaluateHandle(INTERACT_BY_INDEX_JS, index);
}

/**
 * Format page state as a concise text block for LLM consumption.
 */
export function formatPageStateForLLM(state: PageState): string {
  const lines = [
    `Page: "${state.title}"`,
    `URL: ${state.url}`,
    `Scroll: ${state.scrollPosition.y}/${state.scrollHeight - state.viewportHeight}px`,
    "",
    "Interactive elements:",
    state.elementTree || "(no interactive elements found)",
  ];
  return lines.join("\n");
}
