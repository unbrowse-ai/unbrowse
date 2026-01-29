/**
 * Browser-Use TypeScript Port - LLM Element Finder
 *
 * Uses LLM to find elements by natural language description.
 * Similar to browser-use's `get_element_by_prompt` and `must_get_element_by_prompt`.
 */

import type { Page } from "playwright";
import type { LLMProvider } from "./agent.js";
import type { InteractiveElement, BrowserState } from "./types.js";
import { DOMService } from "./dom-service.js";

export interface ElementFinderResult {
  index: number | null;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

const ELEMENT_FINDER_SYSTEM_PROMPT = `You are an AI that finds elements on a webpage by description.

<browser_state_format>
Interactive elements are listed as: [index]<tagName type="..."> text/label
- index: Numeric identifier for interaction
- tagName: HTML element type (button, input, a, etc.)
- type: Input type if applicable
- text: Element's visible text or aria-label

Examples:
[1]<input type="text" placeholder="Search...">
[5]<button> Submit Form
[12]<a href="/login"> Sign In
</browser_state_format>

<task>
Given a description of an element, find the matching element index from the list.
Return the index number that best matches the description.
If no element matches, return null.
</task>

<output_format>
Respond with JSON only:
{
  "thinking": "Brief reasoning about which element matches",
  "index": <number or null>,
  "confidence": "high" | "medium" | "low"
}
</output_format>`;

/**
 * Find an element by natural language description using LLM
 */
export async function findElementByPrompt(
  prompt: string,
  browserState: BrowserState,
  llm: LLMProvider
): Promise<ElementFinderResult> {
  // Format elements for LLM
  const elementsText = browserState.interactiveElements
    .map((el) => {
      const attrs: string[] = [];
      if (el.type) attrs.push(`type="${el.type}"`);
      if (el.placeholder) attrs.push(`placeholder="${el.placeholder}"`);
      if (el.href) attrs.push(`href="${el.href.slice(0, 50)}"`);
      if (el.role) attrs.push(`role="${el.role}"`);

      const label = el.ariaLabel || el.text || el.placeholder || "";
      const attrStr = attrs.length ? " " + attrs.join(" ") : "";

      return `[${el.index}]<${el.tagName}${attrStr}> ${label.slice(0, 80)}`;
    })
    .join("\n");

  const userMessage = `Current page: ${browserState.url}
Title: ${browserState.title}

Interactive elements:
${elementsText}

Find element matching: "${prompt}"`;

  const response = await llm.chat([
    { role: "system", content: ELEMENT_FINDER_SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ]);

  // Parse response
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { index: null, confidence: "low", reasoning: "Failed to parse LLM response" };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const index = parsed.index;

    // Validate index exists in elements
    if (index !== null) {
      const exists = browserState.interactiveElements.some((el) => el.index === index);
      if (!exists) {
        return {
          index: null,
          confidence: "low",
          reasoning: `LLM returned index ${index} which doesn't exist`,
        };
      }
    }

    return {
      index: index ?? null,
      confidence: parsed.confidence || "medium",
      reasoning: parsed.thinking || "",
    };
  } catch {
    return { index: null, confidence: "low", reasoning: "Failed to parse LLM response" };
  }
}

/**
 * Find element by prompt, throwing if not found
 */
export async function mustFindElementByPrompt(
  prompt: string,
  browserState: BrowserState,
  llm: LLMProvider
): Promise<number> {
  const result = await findElementByPrompt(prompt, browserState, llm);

  if (result.index === null) {
    throw new Error(`No element found matching: "${prompt}". ${result.reasoning}`);
  }

  return result.index;
}

/**
 * Element Finder class for stateful element finding
 */
export class ElementFinder {
  private page: Page;
  private domService: DOMService;
  private llm: LLMProvider;

  constructor(page: Page, llm: LLMProvider, domService?: DOMService) {
    this.page = page;
    this.llm = llm;
    this.domService = domService ?? new DOMService(page);
  }

  /**
   * Find element by description
   */
  async find(description: string): Promise<ElementFinderResult> {
    const state = await this.domService.getBrowserState();
    return findElementByPrompt(description, state, this.llm);
  }

  /**
   * Find element by description, throw if not found
   */
  async mustFind(description: string): Promise<number> {
    const state = await this.domService.getBrowserState();
    return mustFindElementByPrompt(description, state, this.llm);
  }

  /**
   * Find and click element by description
   */
  async findAndClick(description: string): Promise<void> {
    const index = await this.mustFind(description);
    const locator = await this.domService.getLocatorByIndex(index);
    if (!locator) {
      throw new Error(`Element ${index} found but locator unavailable`);
    }
    await locator.click();
  }

  /**
   * Find and fill element by description
   */
  async findAndFill(description: string, text: string): Promise<void> {
    const index = await this.mustFind(description);
    const locator = await this.domService.getLocatorByIndex(index);
    if (!locator) {
      throw new Error(`Element ${index} found but locator unavailable`);
    }
    await locator.fill(text);
  }

  /**
   * Check if element matching description exists
   */
  async exists(description: string): Promise<boolean> {
    const result = await this.find(description);
    return result.index !== null && result.confidence !== "low";
  }
}
