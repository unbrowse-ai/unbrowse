/**
 * Browser-Use TypeScript Port - Markdown Extractor
 *
 * Extracts clean, readable markdown from web pages.
 * Removes ads, navigation, boilerplate content.
 */

import type { Page } from "playwright";

export interface MarkdownExtractionResult {
  markdown: string;
  stats: {
    totalLength: number;
    headings: number;
    links: number;
    images: number;
    lists: number;
    codeBlocks: number;
  };
}

/**
 * Extract clean markdown from a page
 */
export async function extractMarkdown(
  page: Page,
  options: {
    includeLinks?: boolean;
    includeImages?: boolean;
    maxLength?: number;
    removeNavigation?: boolean;
    removeAds?: boolean;
  } = {}
): Promise<MarkdownExtractionResult> {
  const {
    includeLinks = true,
    includeImages = false,
    maxLength = 50000,
    removeNavigation = true,
    removeAds = true,
  } = options;

  const result = await page.evaluate(
    ({ includeLinks, includeImages, removeNavigation, removeAds }) => {
      // Selectors for content to remove
      const NAV_SELECTORS = [
        "nav",
        "header",
        "footer",
        "[role='navigation']",
        "[role='banner']",
        "[role='contentinfo']",
        ".nav",
        ".navbar",
        ".header",
        ".footer",
        ".menu",
        ".sidebar",
        "#nav",
        "#header",
        "#footer",
        "#sidebar",
        ".breadcrumb",
        ".pagination",
      ];

      const AD_SELECTORS = [
        "[class*='ad-']",
        "[class*='ads-']",
        "[class*='advert']",
        "[id*='ad-']",
        "[id*='ads-']",
        "[data-ad]",
        ".sponsored",
        ".advertisement",
        ".ad-container",
        "ins.adsbygoogle",
        "[aria-label*='advertisement']",
      ];

      const BOILERPLATE_SELECTORS = [
        ".cookie-banner",
        ".cookie-consent",
        ".newsletter-signup",
        ".popup",
        ".modal",
        ".overlay",
        "[class*='cookie']",
        "[class*='gdpr']",
        "[class*='consent']",
        ".social-share",
        ".share-buttons",
        ".comments",
        "#comments",
        ".related-posts",
        ".recommended",
      ];

      // Clone document to avoid modifying actual page
      const doc = document.cloneNode(true) as Document;

      // Remove unwanted elements
      const selectorsToRemove: string[] = [];
      if (removeNavigation) selectorsToRemove.push(...NAV_SELECTORS);
      if (removeAds) selectorsToRemove.push(...AD_SELECTORS);
      selectorsToRemove.push(...BOILERPLATE_SELECTORS);

      for (const selector of selectorsToRemove) {
        try {
          doc.querySelectorAll(selector).forEach((el) => el.remove());
        } catch {
          // Invalid selector, skip
        }
      }

      // Also remove script, style, noscript, svg, canvas
      doc.querySelectorAll("script, style, noscript, svg, canvas, iframe").forEach((el) => el.remove());

      // Find main content area
      const mainSelectors = [
        "main",
        "article",
        "[role='main']",
        "#content",
        "#main",
        ".content",
        ".main",
        ".post",
        ".article",
        ".entry-content",
        ".post-content",
      ];

      let contentRoot: Element | null = null;
      for (const sel of mainSelectors) {
        const el = doc.querySelector(sel);
        if (el && el.textContent && el.textContent.trim().length > 200) {
          contentRoot = el;
          break;
        }
      }

      // Fallback to body
      if (!contentRoot) {
        contentRoot = doc.body;
      }

      // Convert to markdown
      const lines: string[] = [];
      let stats = {
        headings: 0,
        links: 0,
        images: 0,
        lists: 0,
        codeBlocks: 0,
      };

      function processNode(node: Node, depth: number = 0): void {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent?.trim();
          if (text) {
            lines.push(text);
          }
          return;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const el = node as Element;
        const tag = el.tagName.toLowerCase();

        // Skip hidden elements
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") {
          return;
        }

        // Handle specific elements
        switch (tag) {
          case "h1":
            lines.push(`\n# ${el.textContent?.trim()}\n`);
            stats.headings++;
            return;
          case "h2":
            lines.push(`\n## ${el.textContent?.trim()}\n`);
            stats.headings++;
            return;
          case "h3":
            lines.push(`\n### ${el.textContent?.trim()}\n`);
            stats.headings++;
            return;
          case "h4":
            lines.push(`\n#### ${el.textContent?.trim()}\n`);
            stats.headings++;
            return;
          case "h5":
          case "h6":
            lines.push(`\n##### ${el.textContent?.trim()}\n`);
            stats.headings++;
            return;

          case "p":
            const pText = el.textContent?.trim();
            if (pText) {
              lines.push(`\n${pText}\n`);
            }
            return;

          case "a":
            if (includeLinks) {
              const href = el.getAttribute("href");
              const text = el.textContent?.trim();
              if (href && text) {
                lines.push(`[${text}](${href})`);
                stats.links++;
              }
            } else {
              lines.push(el.textContent?.trim() || "");
            }
            return;

          case "img":
            if (includeImages) {
              const src = el.getAttribute("src");
              const alt = el.getAttribute("alt") || "";
              if (src) {
                lines.push(`![${alt}](${src})`);
                stats.images++;
              }
            }
            return;

          case "ul":
          case "ol":
            lines.push("");
            const items = el.querySelectorAll(":scope > li");
            const isOrdered = tag === "ol";
            items.forEach((li, i) => {
              const prefix = isOrdered ? `${i + 1}. ` : "- ";
              lines.push(`${prefix}${li.textContent?.trim()}`);
            });
            lines.push("");
            stats.lists++;
            return;

          case "pre":
          case "code":
            const codeText = el.textContent?.trim();
            if (codeText) {
              if (tag === "pre" || codeText.includes("\n")) {
                lines.push(`\n\`\`\`\n${codeText}\n\`\`\`\n`);
                stats.codeBlocks++;
              } else {
                lines.push(`\`${codeText}\``);
              }
            }
            return;

          case "blockquote":
            const quoteText = el.textContent?.trim();
            if (quoteText) {
              lines.push(
                `\n${quoteText
                  .split("\n")
                  .map((l) => `> ${l}`)
                  .join("\n")}\n`
              );
            }
            return;

          case "hr":
            lines.push("\n---\n");
            return;

          case "br":
            lines.push("\n");
            return;

          case "table":
            // Simple table extraction
            const rows = el.querySelectorAll("tr");
            if (rows.length > 0) {
              lines.push("");
              rows.forEach((row, rowIdx) => {
                const cells = row.querySelectorAll("th, td");
                const cellTexts = Array.from(cells).map((c) => c.textContent?.trim() || "");
                lines.push(`| ${cellTexts.join(" | ")} |`);
                if (rowIdx === 0) {
                  lines.push(`| ${cellTexts.map(() => "---").join(" | ")} |`);
                }
              });
              lines.push("");
            }
            return;

          case "strong":
          case "b":
            lines.push(`**${el.textContent?.trim()}**`);
            return;

          case "em":
          case "i":
            lines.push(`*${el.textContent?.trim()}*`);
            return;

          default:
            // Recurse into children
            for (const child of el.childNodes) {
              processNode(child, depth + 1);
            }
        }
      }

      processNode(contentRoot);

      // Clean up markdown
      let markdown = lines
        .join(" ")
        .replace(/\n{3,}/g, "\n\n") // Max 2 newlines
        .replace(/\s+/g, " ") // Collapse whitespace
        .replace(/ \n/g, "\n") // Remove trailing spaces
        .replace(/\n /g, "\n") // Remove leading spaces
        .trim();

      // Restore intentional newlines from headings/blocks
      markdown = markdown
        .replace(/ (#{1,6} )/g, "\n\n$1")
        .replace(/ (```)/g, "\n$1")
        .replace(/(```) /g, "$1\n")
        .replace(/ (---) /g, "\n$1\n")
        .replace(/ (> )/g, "\n$1");

      return { markdown, stats };
    },
    { includeLinks, includeImages, removeNavigation, removeAds }
  );

  // Truncate if needed
  let markdown = result.markdown;
  if (markdown.length > maxLength) {
    markdown = markdown.slice(0, maxLength) + "\n\n...[truncated]";
  }

  return {
    markdown,
    stats: {
      totalLength: markdown.length,
      ...result.stats,
    },
  };
}

/**
 * Extract structured content from page using LLM
 */
export async function extractStructuredContent<T>(
  page: Page,
  prompt: string,
  llm: { chat: (messages: Array<{ role: string; content: string }>) => Promise<string> },
  outputSchema?: { parse: (data: unknown) => T }
): Promise<T | string> {
  const { markdown } = await extractMarkdown(page, {
    includeLinks: true,
    maxLength: 30000,
  });

  const systemPrompt = `You are an expert at extracting structured data from webpage content.

<instructions>
- Extract ONLY information present in the provided content
- Do NOT make up or infer missing information
- If information is not available, say so explicitly
- Return data in the exact format requested
</instructions>`;

  const userPrompt = `<query>
${prompt}
</query>

<webpage_content>
${markdown}
</webpage_content>

Extract the requested information and return as JSON.`;

  const response = await llm.chat([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);

  // Try to parse JSON from response
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (outputSchema) {
        return outputSchema.parse(parsed);
      }
      return parsed;
    }
  } catch {
    // Return raw response if JSON parsing fails
  }

  return response as unknown as T;
}
