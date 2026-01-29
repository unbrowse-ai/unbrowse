/**
 * Browser-Use TypeScript Port - DOM Service
 *
 * Extracts interactive elements from the page and indexes them
 * for the LLM to reference in actions.
 *
 * Features:
 * - Stable element indexing using data attributes
 * - New element detection for LLM awareness
 * - Cached element selectors for reliable action execution
 * - Enhanced visibility detection with computed styles
 * - Scroll position awareness for viewport filtering
 */

import type { Page, Locator } from "playwright";
import type { InteractiveElement, BrowserState, TabInfo } from "./types.js";

// Computed styles to check for visibility
const VISIBILITY_STYLES = [
  "display",
  "visibility",
  "opacity",
  "pointerEvents",
  "overflow",
  "clip",
  "clipPath",
] as const;

// Selectors for interactive elements
const INTERACTIVE_SELECTORS = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='option']",
  "[role='combobox']",
  "[role='textbox']",
  "[role='searchbox']",
  "[onclick]",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
  "summary",
  "details",
  "[aria-haspopup]",
  "[data-action]",
  "[data-click]",
].join(", ");

// Attributes to include in element info
const INCLUDE_ATTRIBUTES = [
  "aria-label",
  "aria-describedby",
  "placeholder",
  "title",
  "alt",
  "name",
  "value",
  "href",
  "type",
  "role",
];

// Attribute used to mark indexed elements for stable retrieval
const INDEX_ATTRIBUTE = "data-bu-index";

export class DOMService {
  private page: Page;
  private previousElementHashes = new Set<string>();
  private elementCache = new Map<number, {
    selector: string;
    tagName: string;
    text: string;
  }>();

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Get a stable locator for an element by its index
   * Uses the data attribute we set during extraction for reliability
   */
  async getLocatorByIndex(index: number): Promise<Locator | null> {
    try {
      // Primary method: use the data attribute
      const locator = this.page.locator(`[${INDEX_ATTRIBUTE}="${index}"]`);
      const count = await locator.count();

      if (count === 1) {
        return locator;
      }

      // Fallback: use cached selector info if available
      const cached = this.elementCache.get(index);
      if (cached) {
        // Try to find by unique selector
        const fallbackLocator = this.page.locator(cached.selector);
        const fallbackCount = await fallbackLocator.count();
        if (fallbackCount === 1) {
          return fallbackLocator;
        }
      }

      // Last resort: re-extract and find by position
      const elements = await this.getInteractiveElements();
      const element = elements.find(e => e.index === index);
      if (element) {
        return this.page.locator(`[${INDEX_ATTRIBUTE}="${index}"]`);
      }

      return null;
    } catch (err) {
      console.error(`[dom-service] Failed to get locator for index ${index}:`, err);
      return null;
    }
  }

  /**
   * Get the current browser state including all interactive elements
   */
  async getBrowserState(): Promise<BrowserState> {
    const [url, title, elements, scrollInfo, tabs] = await Promise.all([
      this.page.url(),
      this.page.title(),
      this.getInteractiveElements(),
      this.getScrollInfo(),
      this.getTabs(),
    ]);

    return {
      url,
      title,
      tabs,
      interactiveElements: elements,
      scrollPosition: scrollInfo.position,
      scrollHeight: scrollInfo.scrollHeight,
      viewportHeight: scrollInfo.viewportHeight,
    };
  }

  /**
   * Extract all interactive elements from the page
   * Also marks each element with a data attribute for stable retrieval
   */
  async getInteractiveElements(): Promise<InteractiveElement[]> {
    const elements: InteractiveElement[] = [];
    const newHashes = new Set<string>();

    try {
      // First, remove old index attributes to avoid stale references
      await this.page.evaluate((attr) => {
        document.querySelectorAll(`[${attr}]`).forEach(el => {
          el.removeAttribute(attr);
        });
      }, INDEX_ATTRIBUTE);

      const rawElements = await this.page.evaluate(({ selectors, indexAttr }) => {
        const results: Array<{
          tagName: string;
          text: string;
          attributes: Record<string, string>;
          boundingBox: { x: number; y: number; width: number; height: number } | null;
          selector: string;
          hash: string;
          uniqueSelector: string;
        }> = [];

        const allElements = document.querySelectorAll(selectors);
        let currentIndex = 1;

        // Helper: check if element is truly visible
        const isElementVisible = (el: Element): boolean => {
          const style = window.getComputedStyle(el);

          // Basic visibility checks
          if (style.display === "none") return false;
          if (style.visibility === "hidden" || style.visibility === "collapse") return false;
          if (parseFloat(style.opacity) <= 0.1) return false;
          if (style.pointerEvents === "none") return false;

          // Check for clipping
          if (style.clip === "rect(0px, 0px, 0px, 0px)") return false;
          if (style.clipPath === "inset(100%)") return false;

          // Check if element is offscreen via transform
          const transform = style.transform;
          if (transform && transform !== "none") {
            const match = transform.match(/translate[XY]?\(([^)]+)\)/);
            if (match) {
              const value = parseFloat(match[1]);
              if (Math.abs(value) > 10000) return false;
            }
          }

          // Check parent visibility recursively (up to 5 levels)
          let parent = el.parentElement;
          let depth = 0;
          while (parent && depth < 5) {
            const parentStyle = window.getComputedStyle(parent);
            if (parentStyle.display === "none") return false;
            if (parentStyle.visibility === "hidden") return false;
            if (parseFloat(parentStyle.opacity) <= 0) return false;
            parent = parent.parentElement;
            depth++;
          }

          return true;
        };

        for (const el of allElements) {
          // Enhanced visibility check
          if (!isElementVisible(el)) continue;

          // Get bounding box
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;

          // Check minimum size (elements < 5x5 are likely hidden)
          if (rect.width < 5 && rect.height < 5) continue;

          // Only include elements in viewport (with buffer for scrolling)
          const viewportHeight = window.innerHeight;
          const viewportWidth = window.innerWidth;
          const buffer = 200; // Include elements slightly outside viewport

          // Skip elements completely outside viewport
          if (rect.bottom < -buffer || rect.top > viewportHeight + buffer) continue;
          if (rect.right < -buffer || rect.left > viewportWidth + buffer) continue;

          // Mark element with index attribute for stable retrieval
          el.setAttribute(indexAttr, String(currentIndex));

          // Get text content
          let text = "";
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            text = el.value || el.placeholder || "";
          } else if (el instanceof HTMLSelectElement) {
            text = el.options[el.selectedIndex]?.text || "";
          } else {
            text = el.textContent?.trim().slice(0, 100) || "";
          }

          // Get relevant attributes
          const attributes: Record<string, string> = {};
          const attrNames = [
            "aria-label", "aria-describedby", "placeholder",
            "title", "alt", "name", "href", "type", "role", "value"
          ];
          for (const attr of attrNames) {
            const val = el.getAttribute(attr);
            if (val) attributes[attr] = val;
          }

          // Generate display selector
          const tagName = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : "";
          const classes = el.className && typeof el.className === "string"
            ? "." + el.className.split(" ").filter(Boolean).slice(0, 2).join(".")
            : "";
          const selector = `${tagName}${id}${classes}`.slice(0, 100);

          // Generate unique CSS selector for fallback
          let uniqueSelector = "";
          if (el.id) {
            uniqueSelector = `#${el.id}`;
          } else {
            // Build path-based selector
            const path: string[] = [];
            let current: Element | null = el;
            while (current && current !== document.body && path.length < 4) {
              const tag = current.tagName.toLowerCase();
              const nth = current.parentElement
                ? Array.from(current.parentElement.children)
                    .filter(c => c.tagName === current!.tagName)
                    .indexOf(current) + 1
                : 1;
              path.unshift(`${tag}:nth-of-type(${nth})`);
              current = current.parentElement;
            }
            uniqueSelector = path.join(" > ");
          }

          // Create hash for change detection
          const hash = `${tagName}:${text.slice(0, 30)}:${attributes["aria-label"] || ""}:${Math.round(rect.x / 10)}:${Math.round(rect.y / 10)}`;

          results.push({
            tagName,
            text,
            attributes,
            boundingBox: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
            selector,
            uniqueSelector,
            hash,
          });

          currentIndex++;
        }

        return results;
      }, { selectors: INTERACTIVE_SELECTORS, indexAttr: INDEX_ATTRIBUTE });

      // Process and index elements, update cache
      this.elementCache.clear();
      let index = 1;
      for (const raw of rawElements) {
        newHashes.add(raw.hash);
        const isNew = !this.previousElementHashes.has(raw.hash);

        // Cache element info for fallback retrieval
        this.elementCache.set(index, {
          selector: raw.uniqueSelector,
          tagName: raw.tagName,
          text: raw.text,
        });

        elements.push({
          index,
          tagName: raw.tagName,
          text: raw.text,
          role: raw.attributes.role,
          ariaLabel: raw.attributes["aria-label"],
          placeholder: raw.attributes.placeholder,
          href: raw.attributes.href,
          type: raw.attributes.type,
          isNew,
          selector: raw.selector,
          boundingBox: raw.boundingBox || undefined,
        });
        index++;
      }

      // Update previous hashes for next comparison
      this.previousElementHashes = newHashes;
    } catch (err) {
      console.error("[dom-service] Failed to get interactive elements:", err);
    }

    return elements;
  }

  /**
   * Get scroll position and dimensions
   */
  private async getScrollInfo(): Promise<{
    position: { x: number; y: number };
    scrollHeight: number;
    viewportHeight: number;
  }> {
    try {
      return await this.page.evaluate(() => ({
        position: {
          x: window.scrollX,
          y: window.scrollY,
        },
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
      }));
    } catch {
      return {
        position: { x: 0, y: 0 },
        scrollHeight: 0,
        viewportHeight: 0,
      };
    }
  }

  /**
   * Get all open tabs
   */
  private async getTabs(): Promise<TabInfo[]> {
    const context = this.page.context();
    const pages = context.pages();
    const currentPage = this.page;

    return Promise.all(
      pages.map(async (page, index) => ({
        id: index,
        url: page.url(),
        title: await page.title().catch(() => ""),
        active: page === currentPage,
      }))
    );
  }

  /**
   * Format browser state as text for the LLM
   */
  formatBrowserState(state: BrowserState): string {
    const lines: string[] = [];

    lines.push(`Current URL: ${state.url}`);
    lines.push(`Title: ${state.title}`);

    // Tabs
    if (state.tabs.length > 1) {
      lines.push("");
      lines.push("Open Tabs:");
      for (const tab of state.tabs) {
        const active = tab.active ? " (active)" : "";
        lines.push(`  [${tab.id}] ${tab.title || tab.url}${active}`);
      }
    }

    // Scroll position
    const scrollPercent = state.scrollHeight > 0
      ? Math.round((state.scrollPosition.y / (state.scrollHeight - state.viewportHeight)) * 100)
      : 0;
    lines.push("");
    lines.push(`Scroll: ${state.scrollPosition.y}/${state.scrollHeight}px (${scrollPercent}%)`);

    // Interactive elements
    lines.push("");
    lines.push("Interactive Elements:");
    for (const el of state.interactiveElements) {
      const star = el.isNew ? "*" : "";
      const label = el.ariaLabel || el.text || el.placeholder || el.href || "";
      const truncatedLabel = label.length > 80 ? label.slice(0, 77) + "..." : label;
      lines.push(`${star}[${el.index}] <${el.tagName}${el.type ? ` type="${el.type}"` : ""}> ${truncatedLabel}`);
    }

    return lines.join("\n");
  }

  /**
   * Get element by index (legacy - use getLocatorByIndex instead)
   * @deprecated Use getLocatorByIndex for stable element retrieval
   */
  async getElementByIndex(index: number): Promise<Locator | null> {
    return this.getLocatorByIndex(index);
  }

  /**
   * Clear element cache and index attributes
   * Call this when navigating to a new page
   */
  async clearCache(): Promise<void> {
    this.elementCache.clear();
    this.previousElementHashes.clear();

    try {
      await this.page.evaluate((attr) => {
        document.querySelectorAll(`[${attr}]`).forEach(el => {
          el.removeAttribute(attr);
        });
      }, INDEX_ATTRIBUTE);
    } catch {
      // Page might be navigating, ignore
    }
  }

  /**
   * Update the page reference (for tab switching)
   */
  setPage(page: Page): void {
    this.page = page;
    this.clearCache();
  }
}
