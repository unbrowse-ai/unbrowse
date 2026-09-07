export interface VisualContextBrowser {
  newTab(url: string): Promise<string>;
  screenshot(tabId: string): Promise<string>;
  closeTab(tabId: string): Promise<void>;
}

export interface ResolveVisualContext {
  screenshot: string;
}

/** One bounded, stateless value-producing browser primitive for resolve.
 * The temporary tab is always closed; failures return null rather than a
 * success-shaped object with missing pixels. */
export async function captureResolveVisualContext(
  url: string,
  browser: VisualContextBrowser,
  options: { settleMs?: number; timeoutMs?: number } = {},
): Promise<ResolveVisualContext | null> {
  const settleMs = options.settleMs ?? 3_000;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let tabId: string | null = null;
  const work = async (): Promise<ResolveVisualContext | null> => {
    tabId = await browser.newTab(url);
    if (!tabId) return null;
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    const screenshot = await browser.screenshot(tabId);
    return typeof screenshot === "string" && screenshot.length > 0 ? { screenshot } : null;
  };
  try {
    return await Promise.race([
      work(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  } finally {
    if (tabId) {
      try { await browser.closeTab(tabId); } catch { /* best-effort cleanup */ }
    }
  }
}
