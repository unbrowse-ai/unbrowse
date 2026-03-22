import { expect, test } from "bun:test";
import { scanHtmlForFetchRoutes } from "../src/execution/index.js";

test("discovers public JSON fetch routes from html preload hints", () => {
  const html = `
    <html>
      <head>
        <link rel="preload" as="fetch" href="https://api.nusmods.com/v2/2025-2026/moduleList.json" crossorigin="anonymous">
        <link rel="prefetch" href="https://api.nusmods.com/v2/2025-2026/semesters/2/venueInformation.json">
        <link rel="preload" as="script" href="/assets/main.js">
      </head>
    </html>
  `;

  const endpoints = scanHtmlForFetchRoutes(html, "https://nusmods.com/");
  const urls = endpoints.map((endpoint) => endpoint.url_template);

  expect(urls).toContain("https://api.nusmods.com/v2/2025-2026/moduleList.json");
  expect(urls).toContain("https://api.nusmods.com/v2/2025-2026/semesters/2/venueInformation.json");
  expect(urls.some((url) => url.endsWith("/assets/main.js"))).toBe(false);
});
