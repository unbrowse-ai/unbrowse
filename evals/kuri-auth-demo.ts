/**
 * Auth demo using Kuri directly — no agent-browser/Playwright dependency.
 * Tests scripted login on sites with baked-in test accounts.
 *
 * Usage: bun evals/kuri-auth-demo.ts
 */

import * as kuri from "../src/kuri/client.ts";

interface AuthDemo {
  name: string;
  loginUrl: string;
  steps: () => Promise<{ tab: string }>;
  verify: (tab: string) => Promise<{ passed: boolean; details: string }>;
}

/** React-compatible input fill: uses native setter to bypass controlled components. */
async function fill(tab: string, selector: string, value: string): Promise<void> {
  await kuri.evaluate(tab, `(function() {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error("element not found: ${selector}");
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
}

async function click(tab: string, selector: string): Promise<void> {
  await kuri.evaluate(tab, `document.querySelector(${JSON.stringify(selector)}).click()`);
}

async function waitForUrl(tab: string, pattern: string | RegExp, timeoutMs = 10000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = await kuri.evaluate(tab, "window.location.href") as string;
    if (typeof pattern === "string" ? url.includes(pattern) : pattern.test(url)) return url;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`URL did not match ${pattern} within ${timeoutMs}ms`);
}

const demos: AuthDemo[] = [
  {
    name: "saucedemo.com (React SPA)",
    loginUrl: "https://www.saucedemo.com/",
    steps: async () => {
      const tab = await kuri.newTab("about:blank");
      await kuri.navigate(tab, "https://www.saucedemo.com/");
      await new Promise((r) => setTimeout(r, 2000));
      await fill(tab, "#user-name", "standard_user");
      await fill(tab, "#password", "secret_sauce");
      await click(tab, "#login-button");
      await waitForUrl(tab, "inventory");
      return { tab };
    },
    verify: async (tab) => {
      const count = (await kuri.evaluate(tab, `document.querySelectorAll(".inventory_item").length`)) as number;
      const name = await kuri.evaluate(tab, `document.querySelector(".inventory_item_name")?.innerText`);
      return {
        passed: count >= 1,
        details: `${count} products found, first: ${name}`,
      };
    },
  },
  {
    name: "the-internet.herokuapp.com (basic form)",
    loginUrl: "https://the-internet.herokuapp.com/login",
    steps: async () => {
      const tab = await kuri.newTab("about:blank");
      await kuri.navigate(tab, "https://the-internet.herokuapp.com/login");
      await new Promise((r) => setTimeout(r, 2000));
      await fill(tab, "#username", "tomsmith");
      await fill(tab, "#password", "SuperSecretPassword!");
      await click(tab, "button[type=submit]");
      await waitForUrl(tab, "secure");
      return { tab };
    },
    verify: async (tab) => {
      const flash = (await kuri.evaluate(tab, `document.querySelector(".flash")?.innerText?.trim()`)) as string;
      return {
        passed: /secure area/i.test(flash || ""),
        details: flash || "no flash message",
      };
    },
  },
  {
    name: "practicetestautomation.com (standard form)",
    loginUrl: "https://practicetestautomation.com/practice-test-login/",
    steps: async () => {
      const tab = await kuri.newTab("about:blank");
      await kuri.navigate(tab, "https://practicetestautomation.com/practice-test-login/");
      await new Promise((r) => setTimeout(r, 2000));
      await fill(tab, "#username", "student");
      await fill(tab, "#password", "Password123");
      await click(tab, "#submit");
      await waitForUrl(tab, "logged-in-successfully");
      return { tab };
    },
    verify: async (tab) => {
      const text = (await kuri.evaluate(tab, `document.body?.innerText?.substring(0, 200)`)) as string;
      const passed = /logged in successfully|congratulations/i.test(text || "");
      return { passed, details: text?.substring(0, 100) || "empty page" };
    },
  },
];

async function main() {
  await kuri.start();
  console.log(`\n=== Kuri Auth Demo — ${demos.length} sites ===\n`);

  let passed = 0;
  let failed = 0;

  for (const demo of demos) {
    process.stdout.write(`${demo.name} ... `);
    try {
      const { tab } = await demo.steps();
      await new Promise((r) => setTimeout(r, 1000));
      const result = await demo.verify(tab);
      if (result.passed) {
        console.log(`✅ PASS — ${result.details}`);
        passed++;
      } else {
        console.log(`❌ FAIL — ${result.details}`);
        failed++;
      }
    } catch (err) {
      console.log(`❌ ERROR — ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\n${passed}/${passed + failed} passed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
