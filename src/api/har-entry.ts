/**
 * The HAR entry shape — backend-agnostic.
 *
 * This lived in `src/kuri/client.ts` as `KuriHarEntry`, which is a misnomer:
 * nothing about it is kuri's. It is the standard HTTP Archive entry shape
 * (request / response / startedDateTime) that any recorder emits — kuri,
 * Chrome's own devtools export, or a future backend.
 *
 * The name mattered practically, not just aesthetically: importing the type
 * from kuri's module made `src/api/browse-index.ts` — a pure
 * RawRequest-transformation file that never touches a browser — depend on 2,543
 * lines of browser-broker client. Moving it here is what lets the api layer hold
 * exactly one kuri import: the Chrome backend itself, in routes.ts.
 */

/** One recorded request/response pair, in HTTP Archive shape. */
export interface HarEntry {
  request: {
    method: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
    postData?: { text: string };
  };
  response: {
    status: number;
    headers: Array<{ name: string; value: string }>;
    content?: { text?: string; mimeType?: string };
  };
  startedDateTime: string;
}
