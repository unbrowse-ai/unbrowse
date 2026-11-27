// The captcha relay: a member node's createTask / getTaskResult, sent on to the solver Unbrowse pays for with
// Unbrowse's key put in, so a node whose owner signed in on unbrowse.ai can meet a check without a solver of its own.
//
//   POST /<network>/<pass>/createTask       { task }            -> the solver's answer ({ errorId, taskId })
//   POST /<network>/<pass>/getTaskResult    { taskId }          -> the solver's answer ({ errorId, status, solution })
//
// The node speaks the de-facto createTask / getTaskResult protocol (`unbrowse-node/app/src/solver.rs`); this side
// holds the key (SOLVER_KEY, a secret) and how much of it a member may spend. Kept apart from the Worker, as gate.js
// is, so the tests run it under plain node.

/** Where the tasks go. The key is never in it: it travels in the body, put there here. */
export const SOLVER = "https://api.2captcha.com";

/** The tasks relayed: a token for a check the page shows (the solver uses its own network), or where to click on a
 *  picture of one. A task that would send the solver through a proxy, or any other kind, is not. */
export const TASKS = new Set([
  "RecaptchaV2TaskProxyless",
  "RecaptchaV2EnterpriseTaskProxyless",
  "RecaptchaV3TaskProxyless",
  "TurnstileTaskProxyless",
  "GeeTestTaskProxyless",
  "CoordinatesTask",
  "GridTask",
]);

/** How many tasks one Privy user's nodes may start a day, together, and every member together: a check is met once
 *  and its clearance then carries many calls, so a node that needs more is a loop, not a site. */
export const MAX_TASKS_PER_USER_A_DAY = 50;
export const MAX_TASKS_A_DAY = 1000;

/** The largest body taken: a picture task carries the picture (the solver takes up to 600 kB of image). */
export const MAX_BODY_BYTES = 1_000_000;

/** The two calls relayed, by the last piece of the path. */
export const CALLS = new Set(["createTask", "getTaskResult"]);

/** Why a createTask body isn't relayed, or null when it is. */
export function taskRefusal(body) {
  const task = body && body.task;
  if (!task || typeof task !== "object" || Array.isArray(task)) return "a createTask body carries a task";
  if (!TASKS.has(task.type)) return `a ${String(task.type)} task isn't relayed: ${[...TASKS].join(", ")}`;
  if (Object.keys(task).some((k) => /^proxy/i.test(k))) return "a task here names no proxy: the solver uses its own network";
  const isPicture = task.type === "CoordinatesTask" || task.type === "GridTask";
  if (isPicture) {
    if (typeof task.body !== "string" || !task.body) return `a ${task.type} carries the picture as body`;
  } else {
    if (typeof task.websiteURL !== "string" || !/^https?:\/\//i.test(task.websiteURL)) return "a token task names the page's websiteURL";
    if (typeof task.websiteKey !== "string" || !task.websiteKey) return "a token task names the check's websiteKey";
  }
  return null;
}

/** The task id a getTaskResult body asks about, as text, or null. */
export function taskIdOf(body) {
  const id = body && body.taskId;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return String(id);
  if (typeof id === "string" && /^\d{1,20}$/.test(id)) return id;
  return null;
}

/** What is sent to the solver for `call`: only the task (or the task id) the node sent, and the key. Anything else in
 *  the node's body (its own clientKey, a callbackUrl the solver would ping) stays here. */
export function forSolver(call, body, key) {
  return call === "createTask" ? { clientKey: key, task: body.task } : { clientKey: key, taskId: Number(taskIdOf(body)) };
}

/** Why a member may not start a task now, or null when they may: `mine` tasks their nodes started today, `all` every
 *  member's. */
export function overCap(mine, all) {
  if (mine >= MAX_TASKS_PER_USER_A_DAY) return `a Privy account's nodes start at most ${MAX_TASKS_PER_USER_A_DAY} captcha tasks a day`;
  if (all >= MAX_TASKS_A_DAY) return "the members' captcha tasks for today are spent";
  return null;
}

/** An answer in the protocol's own shape, for a refusal made here: the node reads `errorId` and `errorCode` the same
 *  whether the solver or the gateway said no. */
export const solverError = (code, description) => ({ errorId: 1, errorCode: code, errorDescription: description });
