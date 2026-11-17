export interface ExecResult {
  success: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The server's JSON, or null when the answer isn't any. Awaited here because a
 * rejection returned from `resp.json()` passes every caller's success check by
 * throwing past it, which left a session saying "Starting..." for good.
 */
async function readJson(resp: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = await resp.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

export async function execCommand(args: string[]): Promise<ExecResult> {
  let resp: Response;
  try {
    resp = await fetch("/api/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args }),
    });
  } catch {
    return {
      success: false,
      exit_code: null,
      stdout: "",
      stderr: "Network error: dashboard server unreachable",
    };
  }
  const body = await readJson(resp);
  if (!body) {
    return {
      success: false,
      exit_code: null,
      stdout: "",
      stderr: `The dashboard server answered ${resp.status} with no result`,
    };
  }
  // A refusal by the server itself is `{success: false, error}`.
  if (typeof body.error === "string") {
    return { success: false, exit_code: null, stdout: "", stderr: body.error };
  }
  return body as unknown as ExecResult;
}

export function sessionArgs(session: string, ...args: string[]): string[] {
  return ["--session", session, ...args];
}

export async function killSession(
  session: string,
): Promise<{ success: boolean; killed_pid?: number; error?: string }> {
  try {
    const resp = await fetch("/api/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session }),
    });
    const body = await readJson(resp);
    if (!body) return { success: false };
    return body as { success: boolean; killed_pid?: number; error?: string };
  } catch {
    return { success: false };
  }
}
