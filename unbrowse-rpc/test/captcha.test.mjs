import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TASKS, taskRefusal, taskIdOf, forSolver, overCap, MAX_TASKS_PER_USER_A_DAY, MAX_TASKS_A_DAY, solverError } from "../src/captcha.js";

const page = { websiteURL: "https://shop.example/punish", websiteKey: "6Lc-site-key" };

test("a token task for the page's check is relayed, and the task the node already sends is one", () => {
  assert.equal(taskRefusal({ task: { type: "RecaptchaV2EnterpriseTaskProxyless", ...page } }), null);
  assert.equal(taskRefusal({ task: { type: "TurnstileTaskProxyless", ...page } }), null);
  // The node's createTask body (`solver.rs` `create_task_body`) names this type: it must stay relayed.
  const node = readFileSync(new URL("../../unbrowse-node/app/src/solver.rs", import.meta.url), "utf8");
  for (const [, t] of node.matchAll(/"type":\s*"([A-Za-z0-9]+)"/g)) assert.ok(TASKS.has(t), `the node sends ${t}`);
});

test("a picture task carries its picture", () => {
  assert.equal(taskRefusal({ task: { type: "CoordinatesTask", body: "iVBORw0KGgo" } }), null);
  assert.match(taskRefusal({ task: { type: "GridTask" } }), /picture/);
});

test("any other task, a proxied one, or one with no page or key is refused", () => {
  assert.match(taskRefusal({}), /carries a task/);
  assert.match(taskRefusal({ task: [] }), /carries a task/);
  assert.match(taskRefusal({ task: { type: "RecaptchaV2Task", ...page } }), /isn't relayed/, "the proxied variant");
  assert.match(taskRefusal({ task: { type: "ImageToTextTask", body: "x" } }), /isn't relayed/);
  assert.match(taskRefusal({ task: { type: "RecaptchaV2TaskProxyless", ...page, proxyAddress: "1.2.3.4" } }), /no proxy/);
  assert.match(taskRefusal({ task: { type: "RecaptchaV2TaskProxyless", websiteKey: "k" } }), /websiteURL/);
  assert.match(taskRefusal({ task: { type: "RecaptchaV2TaskProxyless", websiteURL: "javascript:1", websiteKey: "k" } }), /websiteURL/);
  assert.match(taskRefusal({ task: { type: "RecaptchaV2TaskProxyless", websiteURL: page.websiteURL } }), /websiteKey/);
});

test("the solver is sent the node's task or task id and Unbrowse's key, and nothing else the node said", () => {
  const task = { type: "RecaptchaV2TaskProxyless", ...page };
  assert.deepEqual(forSolver("createTask", { clientKey: "the node's", callbackUrl: "https://x.example/ping", task }, "KEY"), { clientKey: "KEY", task });
  assert.deepEqual(forSolver("getTaskResult", { clientKey: "the node's", taskId: "81234" }, "KEY"), { clientKey: "KEY", taskId: 81234 });
});

test("a task id is a positive whole number, as a number or its digits", () => {
  assert.equal(taskIdOf({ taskId: 72345678 }), "72345678");
  assert.equal(taskIdOf({ taskId: "72345678" }), "72345678");
  for (const bad of [{}, { taskId: 0 }, { taskId: -1 }, { taskId: 1.5 }, { taskId: "1 OR 1" }, { taskId: null }]) assert.equal(taskIdOf(bad), null, JSON.stringify(bad));
});

test("an account's nodes, and every member together, start at most so many tasks a day", () => {
  assert.equal(overCap(0, 0), null);
  assert.equal(overCap(MAX_TASKS_PER_USER_A_DAY - 1, MAX_TASKS_A_DAY - 1), null);
  assert.match(overCap(MAX_TASKS_PER_USER_A_DAY, 0), /a Privy account/);
  assert.match(overCap(0, MAX_TASKS_A_DAY), /spent/);
});

test("a refusal made here reads like the solver's own", () => {
  assert.deepEqual(solverError("ERROR_DAILY_CAP", "why"), { errorId: 1, errorCode: "ERROR_DAILY_CAP", errorDescription: "why" });
});
