import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

/**
 * Render a Markdown string to an HTML string using micromark with GFM support.
 *
 * The returned HTML is intended to be placed inside a container with the
 * `.blog-markdown` class so the global CSS rules apply typography styles.
 */
export function renderBlogMarkdown(markdown: string): string {
  return micromark(markdown, {
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });
}
