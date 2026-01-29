/**
 * Browser-Use TypeScript Port - Default Actions
 *
 * All built-in browser actions registered with the ActionRegistry.
 * Each action is self-contained with its handler, schema, and metadata.
 */

import type { ActionConfig, ActionContext } from "./action-registry.js";
import type { ActionResult } from "./types.js";

// Key name mappings for sendKeys
const KEY_MAPPINGS: Record<string, string> = {
  "ctrl": "Control", "control": "Control", "cmd": "Meta", "command": "Meta",
  "meta": "Meta", "alt": "Alt", "option": "Alt", "shift": "Shift",
  "enter": "Enter", "return": "Enter", "tab": "Tab", "escape": "Escape",
  "esc": "Escape", "backspace": "Backspace", "delete": "Delete", "del": "Delete",
  "space": " ", "spacebar": " ", "up": "ArrowUp", "down": "ArrowDown",
  "left": "ArrowLeft", "right": "ArrowRight", "arrowup": "ArrowUp",
  "arrowdown": "ArrowDown", "arrowleft": "ArrowLeft", "arrowright": "ArrowRight",
  "f1": "F1", "f2": "F2", "f3": "F3", "f4": "F4", "f5": "F5", "f6": "F6",
  "f7": "F7", "f8": "F8", "f9": "F9", "f10": "F10", "f11": "F11", "f12": "F12",
  "home": "Home", "end": "End", "pageup": "PageUp", "pagedown": "PageDown",
  "insert": "Insert",
};

// =================== NAVIGATION ACTIONS ===================

export const navigateAction: ActionConfig<{ url: string; new_tab?: boolean }> = {
  name: "navigate",
  description: "Navigate to a URL, optionally in a new tab",
  category: "navigation",
  schema: {
    required: ["url"],
    properties: {
      url: { type: "string", description: "URL to navigate to" },
      new_tab: { type: "boolean", description: "Open in new tab", default: false },
    },
  },
  async handler({ url, new_tab }, ctx) {
    if (new_tab) {
      const page = await ctx.context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return { success: true, extractedContent: `Opened new tab and navigated to ${url}` };
    }
    await ctx.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    return { success: true, extractedContent: `Navigated to ${url}` };
  },
};

export const searchAction: ActionConfig<{ query: string; engine?: "duckduckgo" | "google" | "bing" }> = {
  name: "search",
  description: "Search the web using a search engine",
  category: "navigation",
  schema: {
    required: ["query"],
    properties: {
      query: { type: "string", description: "Search query" },
      engine: { type: "string", enum: ["duckduckgo", "google", "bing"], default: "duckduckgo" },
    },
  },
  async handler({ query, engine = "duckduckgo" }, ctx) {
    const encodedQuery = encodeURIComponent(query);
    const urls = {
      duckduckgo: `https://duckduckgo.com/?q=${encodedQuery}`,
      google: `https://www.google.com/search?q=${encodedQuery}&udm=14`,
      bing: `https://www.bing.com/search?q=${encodedQuery}`,
    };
    await ctx.page.goto(urls[engine], { waitUntil: "domcontentloaded", timeout: 30000 });
    return { success: true, extractedContent: `Searched ${engine} for "${query}"` };
  },
};

export const goBackAction: ActionConfig<{}> = {
  name: "go_back",
  description: "Navigate back in browser history",
  category: "navigation",
  async handler(_, ctx) {
    await ctx.page.goBack({ waitUntil: "domcontentloaded" });
    return { success: true, extractedContent: "Navigated back" };
  },
};

export const waitAction: ActionConfig<{ seconds?: number }> = {
  name: "wait",
  description: "Wait for a specified number of seconds",
  category: "navigation",
  retryable: false,
  schema: {
    properties: {
      seconds: { type: "number", description: "Seconds to wait", default: 2 },
    },
  },
  async handler({ seconds = 2 }, ctx) {
    await ctx.page.waitForTimeout(seconds * 1000);
    return { success: true, extractedContent: `Waited ${seconds} seconds` };
  },
};

// =================== INTERACTION ACTIONS ===================

export const clickAction: ActionConfig<{ index: number; coordinate_x?: number; coordinate_y?: number }> = {
  name: "click",
  description: "Click an element by index or coordinates",
  category: "interaction",
  schema: {
    properties: {
      index: { type: "number", description: "Element index to click" },
      coordinate_x: { type: "number", description: "X coordinate for click" },
      coordinate_y: { type: "number", description: "Y coordinate for click" },
    },
  },
  async handler({ index, coordinate_x, coordinate_y }, ctx) {
    if (coordinate_x !== undefined && coordinate_y !== undefined) {
      await ctx.page.mouse.click(coordinate_x, coordinate_y);
      await ctx.page.waitForTimeout(500);
      return { success: true, extractedContent: `Clicked at coordinates (${coordinate_x}, ${coordinate_y})` };
    }

    const locator = await ctx.getElementByIndex(index);
    if (!locator) throw new Error(`Element with index ${index} not found`);

    await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
    await locator.waitFor({ state: "visible", timeout: 5000 });

    try {
      await locator.click({ timeout: 5000 });
    } catch {
      await locator.click({ force: true, timeout: 5000 });
    }
    await ctx.page.waitForTimeout(500);
    return { success: true, extractedContent: `Clicked element ${index}` };
  },
};

export const inputTextAction: ActionConfig<{ index: number; text: string; press_enter?: boolean; clear?: boolean }> = {
  name: "input_text",
  description: "Type text into an input element",
  category: "interaction",
  schema: {
    required: ["index", "text"],
    properties: {
      index: { type: "number", description: "Element index" },
      text: { type: "string", description: "Text to type" },
      press_enter: { type: "boolean", description: "Press Enter after typing", default: false },
      clear: { type: "boolean", description: "Clear existing text first", default: true },
    },
  },
  async handler({ index, text, press_enter, clear = true }, ctx) {
    const locator = await ctx.getElementByIndex(index);
    if (!locator) throw new Error(`Element with index ${index} not found`);

    await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
    await locator.waitFor({ state: "visible", timeout: 5000 });

    try { await locator.click({ timeout: 2000 }); } catch { /* ignore */ }

    if (clear) {
      try {
        await locator.fill(text, { timeout: 5000 });
      } catch {
        await locator.clear();
        await locator.pressSequentially(text, { delay: 50 });
      }
    } else {
      await locator.pressSequentially(text, { delay: 50 });
    }

    if (press_enter) {
      await ctx.page.waitForTimeout(100);
      await locator.press("Enter");
    }

    const truncated = text.length > 50 ? text.slice(0, 50) + "..." : text;
    return { success: true, extractedContent: `Typed "${truncated}" into element ${index}${press_enter ? " and pressed Enter" : ""}` };
  },
};

export const scrollAction: ActionConfig<{ direction: "up" | "down"; amount?: number; pages?: number; index?: number }> = {
  name: "scroll",
  description: "Scroll the page or an element",
  category: "interaction",
  schema: {
    required: ["direction"],
    properties: {
      direction: { type: "string", enum: ["up", "down"] },
      amount: { type: "number", description: "Pixels to scroll" },
      pages: { type: "number", description: "Pages to scroll (10 = to top/bottom)" },
      index: { type: "number", description: "Element index to scroll within" },
    },
  },
  async handler({ direction, amount, pages, index }, ctx) {
    let scrollAmount: number;

    if (pages !== undefined) {
      const viewportHeight = await ctx.page.evaluate(() => window.innerHeight);
      if (pages >= 10) {
        const scrollTo = direction === "down"
          ? await ctx.page.evaluate(() => document.documentElement.scrollHeight)
          : 0;
        await ctx.page.evaluate((y) => window.scrollTo(0, y), scrollTo);
        await ctx.page.waitForTimeout(300);
        return { success: true, extractedContent: `Scrolled to ${direction === "down" ? "bottom" : "top"} of page` };
      }
      scrollAmount = Math.round(viewportHeight * pages);
    } else {
      scrollAmount = amount ?? 500;
    }

    const delta = direction === "down" ? scrollAmount : -scrollAmount;

    if (index !== undefined) {
      const locator = await ctx.getElementByIndex(index);
      if (!locator) return { success: false, error: `Element with index ${index} not found` };
      await locator.evaluate((el, d) => el.scrollBy(0, d), delta);
    } else {
      await ctx.page.evaluate((d) => window.scrollBy(0, d), delta);
    }

    await ctx.page.waitForTimeout(300);
    return { success: true, extractedContent: `Scrolled ${direction} by ${scrollAmount}px${index !== undefined ? ` in element ${index}` : ""}` };
  },
};

export const scrollToTextAction: ActionConfig<{ text: string }> = {
  name: "scroll_to_text",
  description: "Scroll to text on the page",
  category: "interaction",
  schema: {
    required: ["text"],
    properties: {
      text: { type: "string", description: "Text to scroll to" },
    },
  },
  async handler({ text }, ctx) {
    const found = await ctx.page.evaluate((searchText) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent?.includes(searchText)) {
          const element = node.parentElement;
          if (element) {
            element.scrollIntoView({ behavior: "smooth", block: "center" });
            return true;
          }
        }
      }
      return false;
    }, text);

    if (!found) return { success: false, error: `Text "${text}" not found on page` };
    await ctx.page.waitForTimeout(500);
    return { success: true, extractedContent: `Scrolled to text "${text}"` };
  },
};

export const sendKeysAction: ActionConfig<{ keys: string }> = {
  name: "send_keys",
  description: "Send keyboard keys (e.g., Enter, Ctrl+a)",
  category: "interaction",
  schema: {
    required: ["keys"],
    properties: {
      keys: { type: "string", description: "Keys to send (e.g., 'Enter', 'Control+a')" },
    },
  },
  async handler({ keys }, ctx) {
    const normalizeKey = (key: string): string => {
      const lower = key.toLowerCase().trim();
      return KEY_MAPPINGS[lower] || key;
    };

    const parts = keys.split(/\+(?![+])/).map(p => p.trim());

    if (parts.length > 1) {
      const normalized = parts.map(normalizeKey);
      const modifiers = normalized.filter(k => ["Control", "Meta", "Alt", "Shift"].includes(k));
      const mainKeys = normalized.filter(k => !["Control", "Meta", "Alt", "Shift"].includes(k));
      const keyCombo = [...modifiers, ...mainKeys].join("+");
      await ctx.page.keyboard.press(keyCombo);
    } else {
      await ctx.page.keyboard.press(normalizeKey(keys));
    }

    return { success: true, extractedContent: `Sent keys: ${keys}` };
  },
};

export const uploadFileAction: ActionConfig<{ index: number; path: string }> = {
  name: "upload_file",
  description: "Upload a file to a file input",
  category: "interaction",
  schema: {
    required: ["index", "path"],
    properties: {
      index: { type: "number", description: "File input element index" },
      path: { type: "string", description: "Path to file" },
    },
  },
  async handler({ index, path }, ctx) {
    const locator = await ctx.getElementByIndex(index);
    if (!locator) throw new Error(`Element with index ${index} not found`);

    const resolvedPath = path.startsWith("~") ? path.replace("~", process.env.HOME || "") : path;
    await locator.setInputFiles(resolvedPath);
    return { success: true, extractedContent: `Uploaded file "${path}" to element ${index}` };
  },
};

// =================== FORM ACTIONS ===================

export const dropdownOptionsAction: ActionConfig<{ index: number }> = {
  name: "dropdown_options",
  description: "Get available options from a dropdown",
  category: "form",
  includeInMemory: true,
  schema: {
    required: ["index"],
    properties: {
      index: { type: "number", description: "Dropdown element index" },
    },
  },
  async handler({ index }, ctx) {
    const locator = await ctx.getElementByIndex(index);
    if (!locator) return { success: false, error: `Element with index ${index} not found` };

    const options = await locator.evaluate((el) => {
      if (el.tagName.toLowerCase() !== "select") return null;
      const select = el as HTMLSelectElement;
      return Array.from(select.options).map((opt, idx) => ({
        index: idx, value: opt.value, text: opt.textContent?.trim() || "", selected: opt.selected,
      }));
    });

    if (!options) return { success: false, error: `Element ${index} is not a select dropdown` };

    const optionsText = options.map((o) => `${o.selected ? "* " : ""}[${o.index}] ${o.text} (value: ${o.value})`).join("\n");
    return { success: true, extractedContent: `Dropdown options for element ${index}:\n${optionsText}`, includeInMemory: true };
  },
};

export const selectDropdownAction: ActionConfig<{ index: number; text: string }> = {
  name: "select_dropdown",
  description: "Select an option from a dropdown",
  category: "form",
  schema: {
    required: ["index", "text"],
    properties: {
      index: { type: "number", description: "Dropdown element index" },
      text: { type: "string", description: "Option text or value to select" },
    },
  },
  async handler({ index, text }, ctx) {
    const locator = await ctx.getElementByIndex(index);
    if (!locator) throw new Error(`Element with index ${index} not found`);

    try {
      await locator.selectOption({ label: text }, { timeout: 5000 });
    } catch {
      try {
        await locator.selectOption({ value: text }, { timeout: 5000 });
      } catch {
        const matchingOption = await locator.evaluate((el, searchText) => {
          const select = el as HTMLSelectElement;
          for (const opt of select.options) {
            if (opt.text.toLowerCase().includes(searchText.toLowerCase()) ||
                opt.value.toLowerCase().includes(searchText.toLowerCase())) {
              return opt.value;
            }
          }
          return null;
        }, text);

        if (!matchingOption) throw new Error(`No option matching "${text}" found`);
        await locator.selectOption({ value: matchingOption });
      }
    }

    return { success: true, extractedContent: `Selected "${text}" from dropdown ${index}` };
  },
};

// =================== TAB ACTIONS ===================

export const switchTabAction: ActionConfig<{ tab_id: number | string }> = {
  name: "switch_tab",
  description: "Switch to a different browser tab",
  category: "tab",
  retryable: false,
  schema: {
    required: ["tab_id"],
    properties: {
      tab_id: { type: "number", description: "Tab index or URL/title to match" },
    },
  },
  async handler({ tab_id }, ctx) {
    const pages = ctx.context.pages();
    let targetIndex: number;

    if (typeof tab_id === "string") {
      let foundIndex = -1;
      for (let i = 0; i < pages.length; i++) {
        const url = pages[i].url();
        const title = await pages[i].title();
        if (url.includes(tab_id) || title.includes(tab_id)) {
          foundIndex = i;
          break;
        }
      }
      targetIndex = foundIndex !== -1 ? foundIndex : parseInt(tab_id, 10);
    } else {
      targetIndex = tab_id;
    }

    if (targetIndex < 0 || targetIndex >= pages.length || isNaN(targetIndex)) {
      return { success: false, error: `Tab "${tab_id}" not found` };
    }

    await pages[targetIndex].bringToFront();
    return { success: true, extractedContent: `Switched to tab ${targetIndex}` };
  },
};

export const closeTabAction: ActionConfig<{ tab_id?: number | string }> = {
  name: "close_tab",
  description: "Close a browser tab",
  category: "tab",
  retryable: false,
  schema: {
    properties: {
      tab_id: { type: "number", description: "Tab index to close (default: current)" },
    },
  },
  async handler({ tab_id }, ctx) {
    const pages = ctx.context.pages();
    let targetIndex: number;

    if (tab_id === undefined) {
      targetIndex = pages.indexOf(ctx.page);
    } else if (typeof tab_id === "string") {
      let foundIndex = -1;
      for (let i = 0; i < pages.length; i++) {
        const url = pages[i].url();
        const title = await pages[i].title();
        if (url.includes(tab_id) || title.includes(tab_id)) {
          foundIndex = i;
          break;
        }
      }
      targetIndex = foundIndex !== -1 ? foundIndex : parseInt(tab_id, 10);
    } else {
      targetIndex = tab_id;
    }

    if (targetIndex < 0 || targetIndex >= pages.length || isNaN(targetIndex)) {
      return { success: false, error: `Tab "${tab_id}" not found` };
    }

    await pages[targetIndex].close();
    return { success: true, extractedContent: `Closed tab ${targetIndex}` };
  },
};

// =================== EXTRACTION ACTIONS ===================

export const extractAction: ActionConfig<{ query: string; extract_links?: boolean }> = {
  name: "extract",
  description: "Extract content from the page based on a query",
  category: "extraction",
  includeInMemory: true,
  schema: {
    required: ["query"],
    properties: {
      query: { type: "string", description: "What to extract" },
      extract_links: { type: "boolean", description: "Force link extraction", default: false },
    },
  },
  async handler({ query, extract_links }, ctx) {
    const content = await ctx.page.evaluate((extractQuery) => {
      const q = extractQuery.toLowerCase();
      const results: string[] = [];

      // Table extraction
      if (q.includes("table") || q.includes("data") || q.includes("list")) {
        const tables = document.querySelectorAll("table");
        for (const table of tables) {
          const rows: string[] = [];
          const headerCells = table.querySelectorAll("th");
          if (headerCells.length) {
            rows.push(Array.from(headerCells).map(c => c.textContent?.trim()).join(" | "));
          }
          for (const row of table.querySelectorAll("tr")) {
            const cells = row.querySelectorAll("td");
            if (cells.length) {
              rows.push(Array.from(cells).map(c => c.textContent?.trim()).join(" | "));
            }
          }
          if (rows.length) results.push(`TABLE:\n${rows.slice(0, 20).join("\n")}`);
        }
      }

      // Link extraction
      if (q.includes("link") || q.includes("url") || q.includes("href") || q === "__extract_links__") {
        const links = document.querySelectorAll("a[href]");
        const linkData = Array.from(links).slice(0, 50)
          .map(a => `${a.textContent?.trim() || "[no text]"}: ${a.getAttribute("href")}`)
          .filter(Boolean);
        if (linkData.length) results.push(`LINKS:\n${linkData.join("\n")}`);
      }

      // Price extraction
      if (q.includes("price") || q.includes("cost") || q.includes("$")) {
        const priceRegex = /\$[\d,]+\.?\d*|\d+\.\d{2}\s*(USD|EUR|GBP)/gi;
        const prices = document.body.innerText.match(priceRegex);
        if (prices) results.push(`PRICES: ${[...new Set(prices)].slice(0, 20).join(", ")}`);
      }

      // Default: main content
      if (results.length === 0) {
        const mainSelectors = ["main", "article", "[role='main']", "#content", ".content", "#main"];
        let mainContent = "";
        for (const sel of mainSelectors) {
          const main = document.querySelector(sel);
          if (main && main.textContent && main.textContent.trim().length > 100) {
            mainContent = main.textContent.trim();
            break;
          }
        }
        if (!mainContent) mainContent = document.body.innerText;
        results.push(mainContent.replace(/\s+/g, " ").trim().slice(0, 8000));
      }

      return results.join("\n\n---\n\n").slice(0, 10000);
    }, extract_links ? "__extract_links__" : query);

    return { success: true, extractedContent: `Extracted (query: "${query}"):\n${content}`, includeInMemory: true };
  },
};

export const screenshotAction: ActionConfig<{ full_page?: boolean }> = {
  name: "screenshot",
  description: "Take a screenshot of the page",
  category: "extraction",
  retryable: false,
  schema: {
    properties: {
      full_page: { type: "boolean", description: "Capture full page", default: false },
    },
  },
  async handler({ full_page }, ctx) {
    const buffer = await ctx.page.screenshot({ type: "png", fullPage: full_page ?? false });
    const base64 = buffer.toString("base64");
    return { success: true, extractedContent: `data:image/png;base64,${base64}`, includeInMemory: false };
  },
};

// =================== JAVASCRIPT ACTIONS ===================

export const evaluateAction: ActionConfig<{ code: string; variables?: Record<string, any> }> = {
  name: "evaluate",
  description: "Execute JavaScript in the page context",
  category: "javascript",
  includeInMemory: true,
  schema: {
    required: ["code"],
    properties: {
      code: { type: "string", description: "JavaScript code to execute" },
      variables: { type: "object", description: "Variables to pass to the code" },
    },
  },
  async handler({ code, variables }, ctx) {
    try {
      const result = await ctx.page.evaluate(
        ({ code, vars }) => {
          const varEntries = Object.entries(vars || {});
          const fn = new Function(...varEntries.map(([k]) => k), `return (${code})`);
          return fn(...varEntries.map(([, v]) => v));
        },
        { code, vars: variables || {} }
      );

      let resultStr: string;
      if (result === undefined) resultStr = "undefined";
      else if (result === null) resultStr = "null";
      else if (typeof result === "object") {
        try { resultStr = JSON.stringify(result, null, 2); }
        catch { resultStr = String(result); }
      } else resultStr = String(result);

      return { success: true, extractedContent: `JavaScript result:\n${resultStr}`, includeInMemory: true };
    } catch (err) {
      return { success: false, error: `JavaScript execution failed: ${(err as Error).message}` };
    }
  },
};

// =================== FILE ACTIONS ===================

export const writeFileAction: ActionConfig<{ path: string; content: string }> = {
  name: "write_file",
  description: "Write content to a file",
  category: "file",
  retryable: false,
  schema: {
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "File path" },
      content: { type: "string", description: "Content to write" },
    },
  },
  async handler({ path: filePath, content }) {
    try {
      const fs = await import("fs/promises");
      const path = await import("path");
      const resolvedPath = filePath.startsWith("~") ? filePath.replace("~", process.env.HOME || "") : filePath;
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, content, "utf-8");
      return { success: true, extractedContent: `Wrote ${content.length} characters to ${filePath}` };
    } catch (err) {
      return { success: false, error: `Failed to write file: ${(err as Error).message}` };
    }
  },
};

export const readFileAction: ActionConfig<{ path: string }> = {
  name: "read_file",
  description: "Read content from a file",
  category: "file",
  retryable: false,
  includeInMemory: true,
  schema: {
    required: ["path"],
    properties: {
      path: { type: "string", description: "File path" },
    },
  },
  async handler({ path: filePath }) {
    try {
      const fs = await import("fs/promises");
      const resolvedPath = filePath.startsWith("~") ? filePath.replace("~", process.env.HOME || "") : filePath;
      const content = await fs.readFile(resolvedPath, "utf-8");
      const truncated = content.length > 5000 ? content.slice(0, 5000) + "\n...[truncated]" : content;
      return { success: true, extractedContent: `File content (${content.length} chars):\n${truncated}`, includeInMemory: true };
    } catch (err) {
      return { success: false, error: `Failed to read file: ${(err as Error).message}` };
    }
  },
};

export const replaceFileAction: ActionConfig<{ path: string; old_text: string; new_text: string }> = {
  name: "replace_file",
  description: "Replace text in a file",
  category: "file",
  retryable: false,
  schema: {
    required: ["path", "old_text", "new_text"],
    properties: {
      path: { type: "string", description: "File path" },
      old_text: { type: "string", description: "Text to find" },
      new_text: { type: "string", description: "Replacement text" },
    },
  },
  async handler({ path: filePath, old_text, new_text }) {
    try {
      const fs = await import("fs/promises");
      const resolvedPath = filePath.startsWith("~") ? filePath.replace("~", process.env.HOME || "") : filePath;
      const content = await fs.readFile(resolvedPath, "utf-8");
      if (!content.includes(old_text)) {
        return { success: false, error: `Text "${old_text.slice(0, 50)}..." not found in file` };
      }
      await fs.writeFile(resolvedPath, content.replace(old_text, new_text), "utf-8");
      return { success: true, extractedContent: `Replaced text in ${filePath}` };
    } catch (err) {
      return { success: false, error: `Failed to replace in file: ${(err as Error).message}` };
    }
  },
};

// =================== COMPLETION ACTIONS ===================

export const doneAction: ActionConfig<{ text: string; success: boolean }> = {
  name: "done",
  description: "Mark the task as complete",
  category: "completion",
  retryable: false,
  includeInMemory: true,
  schema: {
    required: ["text", "success"],
    properties: {
      text: { type: "string", description: "Final result/answer" },
      success: { type: "boolean", description: "Whether task succeeded" },
    },
  },
  async handler({ text, success }) {
    return { success, extractedContent: text, includeInMemory: true };
  },
};

// =================== ALL DEFAULT ACTIONS ===================

export const defaultActions: ActionConfig[] = [
  // Navigation
  navigateAction,
  searchAction,
  goBackAction,
  waitAction,
  // Interaction
  clickAction,
  inputTextAction,
  scrollAction,
  scrollToTextAction,
  sendKeysAction,
  uploadFileAction,
  // Form
  dropdownOptionsAction,
  selectDropdownAction,
  // Tab
  switchTabAction,
  closeTabAction,
  // Extraction
  extractAction,
  screenshotAction,
  // JavaScript
  evaluateAction,
  // File
  writeFileAction,
  readFileAction,
  replaceFileAction,
  // Completion
  doneAction,
];
