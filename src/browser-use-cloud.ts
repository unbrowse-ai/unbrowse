/**
 * Browser-Use Cloud API Client
 *
 * Integrates with browser-use.com's Cloud API for AI-powered browser automation.
 * See: https://cloud.browser-use.com/
 */

const BROWSER_USE_API_BASE = "https://api.browser-use.com/api/v2";

export interface BrowserUseTask {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "paused" | "stopped";
  prompt: string;
  result?: string;
  error?: string;
  steps?: BrowserUseStep[];
  created_at: string;
  completed_at?: string;
}

export interface BrowserUseStep {
  step_number: number;
  action: string;
  result?: string;
  screenshot_url?: string;
}

export interface CreateTaskOptions {
  prompt: string;
  url?: string;
  profile_id?: string;
  timeout_minutes?: number;
  max_steps?: number;
}

/**
 * Create a new browser automation task
 */
export async function createTask(
  apiKey: string,
  options: CreateTaskOptions,
): Promise<BrowserUseTask> {
  const resp = await fetch(`${BROWSER_USE_API_BASE}/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Browser-Use-API-Key": apiKey,
    },
    body: JSON.stringify({
      prompt: options.prompt,
      url: options.url,
      profile_id: options.profile_id,
      timeout: options.timeout_minutes ?? 15,
      max_steps: options.max_steps ?? 50,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`browser-use API error: ${resp.status} ${text}`);
  }

  return resp.json();
}

/**
 * Get task status and results
 */
export async function getTask(apiKey: string, taskId: string): Promise<BrowserUseTask> {
  const resp = await fetch(`${BROWSER_USE_API_BASE}/tasks/${taskId}`, {
    headers: {
      "X-Browser-Use-API-Key": apiKey,
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`browser-use API error: ${resp.status} ${text}`);
  }

  return resp.json();
}

/**
 * Stop a running task
 */
export async function stopTask(apiKey: string, taskId: string): Promise<void> {
  const resp = await fetch(`${BROWSER_USE_API_BASE}/tasks/${taskId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Browser-Use-API-Key": apiKey,
    },
    body: JSON.stringify({ action: "stop" }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`browser-use API error: ${resp.status} ${text}`);
  }
}

/**
 * Wait for task completion with polling
 */
export async function waitForTask(
  apiKey: string,
  taskId: string,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<BrowserUseTask> {
  const pollInterval = options.pollIntervalMs ?? 2000;
  const timeout = options.timeoutMs ?? 5 * 60 * 1000; // 5 min default
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const task = await getTask(apiKey, taskId);

    if (task.status === "completed" || task.status === "failed" || task.status === "stopped") {
      return task;
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Task ${taskId} timed out after ${timeout}ms`);
}

/**
 * Run a browser task and wait for results
 */
export async function runTask(
  apiKey: string,
  options: CreateTaskOptions,
  waitOptions?: { pollIntervalMs?: number; timeoutMs?: number },
): Promise<BrowserUseTask> {
  const task = await createTask(apiKey, options);
  return waitForTask(apiKey, task.id, waitOptions);
}

/**
 * Create a persistent browser profile for authenticated sessions
 */
export async function createProfile(
  apiKey: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const resp = await fetch(`${BROWSER_USE_API_BASE}/profiles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Browser-Use-API-Key": apiKey,
    },
    body: JSON.stringify({ name }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`browser-use API error: ${resp.status} ${text}`);
  }

  return resp.json();
}

/**
 * List available profiles
 */
export async function listProfiles(
  apiKey: string,
): Promise<Array<{ id: string; name: string }>> {
  const resp = await fetch(`${BROWSER_USE_API_BASE}/profiles`, {
    headers: {
      "X-Browser-Use-API-Key": apiKey,
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`browser-use API error: ${resp.status} ${text}`);
  }

  return resp.json();
}
