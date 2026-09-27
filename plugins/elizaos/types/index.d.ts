import type { Action, Plugin, Provider } from "@elizaos/core";

/** Unbrowse for elizaOS: WEB_FETCH, UNBROWSE_RUN, UNBROWSE_DISCOVER, UNBROWSE_BROWSE, UNBROWSE_RESUME and the UNBROWSE provider. */
export declare const unbrowsePlugin: Plugin;
export default unbrowsePlugin;
/** WEB_FETCH: read one page by URL (unbrowse.scrape). */
export declare const webFetchAction: Action;
/** UNBROWSE_RUN: do a website task in plain words (unbrowse.run), cloud-browser fallback on no_capability. */
export declare const runAction: Action;
/** UNBROWSE_DISCOVER: list matching capabilities (unbrowse.discover). */
export declare const discoverAction: Action;
/** UNBROWSE_BROWSE: open a URL in the cloud browser with a task, return the page, close (unbrowse.browse.*). */
export declare const browseAction: Action;
/** UNBROWSE_RESUME: answer an input_required run (unbrowse.resume). */
export declare const resumeAction: Action;
export declare const unbrowseActions: Action[];
/** UNBROWSE provider: connection status plus a short usage note from the shipped skill. */
export declare const unbrowseProvider: Provider;
