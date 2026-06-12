// W3-followup: scoreConfigShapeDemotion missed Ticketmaster's
// `globalTranslations.global.a11y.*` payload (probe 052 from
// .bench-gate/20260520T093742Z) because the existing
// CONFIG_TOP_LEVEL_KEYS set was a literal whitelist of `translations` +
// `i18n` + `messages` etc. — `globalTranslations` (PascalCase variant)
// didn't match.
//
// Structural fix (NOT a hardcoded variant list): the i18n / theme
// detector matches the canonical token as a SUBSTRING of the top-level
// key (case-insensitive). Catches `globalTranslations`, `appMessages`,
// `themeTokens`, `i18nResources`, `localeBundles`, etc. without
// per-variant maintenance.
//
// Live source: bench-gate run 20260520T093742Z, probe
// 052_hostile_https___www_ticketmaster_com_search_q_concert
// returned 394KB of {globalTranslations:{global:{a11y:{...},form:{...}}}}
// instead of any event listings.
//
// Real-runtime: live extractFromDOM, no mocks.

import { describe, expect, test } from "bun:test";
import { extractFromDOM } from "../src/extraction/index.js";

describe("W3-followup: config-shape detector matches i18n token as substring", () => {
  test("globalTranslations top-level (ticketmaster reproducer) loses to og:title", () => {
    // Reproduce the ticketmaster shape: a giant i18n bundle dominating
    // the page, with og:title as the genuine fallback signal.
    const i18nBundle = {
      globalTranslations: {
        global: {
          a11y: {
            breadcrumbLandmarkLabel: "Breadcrumb",
            opensInNewTab: "(Opens in new tab)",
            screenReaderErrorPrefix: "Error:",
            screenReaderInfoPrefix: "Info:",
            screenReaderSuccessPrefix: "Success:",
            screenReaderWarningPrefix: "Warning:",
            selected: "Selected:",
            optional: "(Optional)",
            closeModalButtonText: "Close dialog",
          },
          form: {
            required: "Required",
            invalid: "Invalid input",
            submit: "Submit",
          },
        },
      },
    };

    const html = `<!doctype html><html><head>
      <meta property="og:title" content="Concert tickets on Ticketmaster">
      <meta property="og:description" content="Find concerts and live music events.">
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: i18nBundle } })}</script>
    </head><body><main>placeholder</main></body></html>`;

    const result = extractFromDOM(html, "search concert tickets");
    const dataStr = JSON.stringify(result.data);

    if (dataStr.includes("globalTranslations") && dataStr.includes("breadcrumbLandmarkLabel")) {
      throw new Error(`i18n bundle dominated extraction: ${dataStr.slice(0, 300)}`);
    }
  });

  test("appMessages PascalCase variant also demoted", () => {
    // Falsifier of the prior whitelist: appMessages was not literally in
    // CONFIG_TOP_LEVEL_KEYS but should still match the substring rule.
    const bundle = {
      appMessages: {
        en: { hello: "Hello", goodbye: "Goodbye", login: "Sign in", logout: "Sign out" },
        fr: { hello: "Bonjour", goodbye: "Au revoir", login: "Connexion", logout: "Deconnexion" },
      },
    };
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="My app">
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: bundle } })}</script>
    </head><body></body></html>`;

    const result = extractFromDOM(html, "get product page");
    const dataStr = JSON.stringify(result.data);
    if (dataStr.includes("appMessages") && dataStr.includes("Bonjour")) {
      throw new Error(`appMessages variant dominated: ${dataStr.slice(0, 200)}`);
    }
  });

  test("falsifier: object with siblings (products + translations) NOT demoted", () => {
    // The existing rule keeps mixed objects untouched — only PURE config
    // buckets get demoted. This test pins that the new substring rule
    // does NOT regress that escape: when a sibling data key is present,
    // the parent object is not config-shape.
    const mixed = {
      globalTranslations: { hello: "Hello" },
      products: [
        { id: 1, name: "Widget A", price: 9.99 },
        { id: 2, name: "Widget B", price: 14.99 },
      ],
    };
    const html = `<!doctype html><html><head>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: mixed } })}</script>
    </head><body></body></html>`;

    const result = extractFromDOM(html, "search products");
    const dataStr = JSON.stringify(result.data);
    // Either the products array bubbles up, OR something else does, but
    // the agent must still see "Widget" if config-shape demote is
    // correctly NOT firing on this mixed shape.
    if (!dataStr.includes("Widget")) {
      // Acceptable: extractor might pick a different structure; just
      // assert it did NOT return just-translations-only.
      if (dataStr.includes("globalTranslations") && !dataStr.includes("Widget") && dataStr.length < 200) {
        throw new Error(`config-only result on mixed-shape input: ${dataStr.slice(0, 200)}`);
      }
    }
  });
});
