/**
 * @experimental Optional SDK embedding primitive; not used by the shipped CLI/MCP path.
 * A deliberately small, dependency-injected model/tool loop.
 *
 * Provider adapters do not belong here. Callers adapt their provider to ChatModel;
 * this module owns only orchestration, budgets, correlation, and auditability.
 */

export interface UserMessage {
  readonly role: "user";
  readonly content: string;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly turn: number;
}

export type ToolMessageStatus = "success" | "error";

export interface ToolMessage {
  readonly role: "tool";
  readonly content: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: ToolMessageStatus;
  readonly ephemeral?: number;
}

export type ChatMessage = UserMessage | AssistantMessage | ToolMessage;

export interface ModelToolCall {
  readonly id?: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface InvokeResult {
  readonly toolCalls: readonly ModelToolCall[];
  readonly text: string;
}

export interface InvocationContext {
  readonly signal: AbortSignal;
  readonly turn: number;
  readonly deadline?: number;
}

export interface JsonSchema {
  readonly [key: string]: unknown;
}

export type ToolResult = string | { readonly content: string };

export interface ToolContext {
  readonly signal: AbortSignal;
  readonly toolCallId: string;
  readonly turn: number;
  readonly deadline?: number;
}

export interface Tool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: JsonSchema;
  readonly ephemeral?: number;
  /** A terminal tool completes the loop after a successful invocation. */
  readonly terminal?: boolean;
  /** Required per-call authorization. Missing authorization fails closed. */
  authorize?(args: Readonly<Record<string, unknown>>, context: ToolContext): Promise<boolean | { decision: "allow" | "ask" | "deny"; reason?: string }>;
  invoke(args: Readonly<Record<string, unknown>>, context: ToolContext): Promise<ToolResult>;
}

export interface ChatModel {
  ainvoke(
    messages: readonly ChatMessage[],
    tools: readonly Tool[],
    context: InvocationContext,
  ): Promise<InvokeResult>;
}

export interface ModelViewOptions {
  readonly maxMessages?: number;
  readonly maxEphemeralMessages?: number;
  readonly maxContentBytes?: number;
  readonly maxModelViewBytes?: number;
}

export interface LoopOptions extends ModelViewOptions {
  readonly signal?: AbortSignal;
  /** Absolute epoch milliseconds. */
  readonly deadline?: number | Date;
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly maxNoProgressTurns?: number;
  readonly now?: () => number;
}

export interface CompletedOutcome {
  readonly status: "completed";
  readonly result: string;
  readonly terminalTool: string;
  readonly turns: number;
  readonly toolCalls: number;
  /** Complete, append-only history. It is never projected or pruned. */
  readonly trace: readonly ChatMessage[];
}

export type LoopOutcome = CompletedOutcome;

export type LoopErrorCode =
  | "ABORTED"
  | "DEADLINE_EXCEEDED"
  | "MAX_TURNS"
  | "MAX_TOOL_CALLS"
  | "NO_PROGRESS"
  | "MODEL_ERROR";

export class AgentLoopError extends Error {
  constructor(
    public readonly code: LoopErrorCode,
    message: string,
    public readonly trace: readonly ChatMessage[],
    public readonly turns: number,
    public readonly toolCalls: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    Object.freeze(this);
  }
}

export class LoopAbortedError extends AgentLoopError {}
export class LoopDeadlineError extends AgentLoopError {}
export class LoopBudgetError extends AgentLoopError {}
export class ModelInvocationError extends AgentLoopError {}

const DEFAULTS = Object.freeze({
  maxTurns: 25,
  maxToolCalls: 100,
  maxNoProgressTurns: 5,
  maxMessages: 64,
  maxEphemeralMessages: 3,
  maxContentBytes: 64 * 1024,
  maxModelViewBytes: 128 * 1024,
});

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) throw new RangeError(`${name} must be a positive integer`);
  return result;
}

function freezeValue<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeValue(child);
    Object.freeze(value);
  }
  return value;
}

function cloneData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneData) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, cloneData(child)]),
    ) as T;
  }
  return value;
}

function boundedText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return `${Buffer.from(value, "utf8").subarray(0, Math.max(0, maxBytes - 16)).toString("utf8")}…[truncated]`;
}

function boundMessage(message: ChatMessage, maxContentBytes: number): ChatMessage {
  return copyMessage({ ...message, content: boundedText(message.content, maxContentBytes) } as ChatMessage);
}

function copyMessage(message: ChatMessage): ChatMessage {
  if (message.role === "assistant") {
    return freezeValue({
      ...message,
      toolCalls: message.toolCalls.map((call) => ({ ...call, args: cloneData(call.args) })),
    });
  }
  return freezeValue({ ...message });
}

function snapshot(trace: readonly ChatMessage[]): readonly ChatMessage[] {
  return Object.freeze(trace.map(copyMessage));
}

/**
 * Builds a bounded model view without changing the audit history. Ephemeral tool
 * messages are limited first, then the complete view is limited to its newest
 * messages. Returned messages are detached immutable copies.
 */
export function projectModelView(
  messages: readonly ChatMessage[],
  options: ModelViewOptions = {},
): readonly ChatMessage[] {
  const maxMessages = positiveInteger(options.maxMessages, DEFAULTS.maxMessages, "maxMessages");
  const maxEphemeral = positiveInteger(
    options.maxEphemeralMessages,
    DEFAULTS.maxEphemeralMessages,
    "maxEphemeralMessages",
  );
  const maxViewBytes = positiveInteger(options.maxModelViewBytes, DEFAULTS.maxModelViewBytes, "maxModelViewBytes");
  if (maxViewBytes < 512) throw new RangeError("maxModelViewBytes must be at least 512");
  const maxContentBytes = Math.min(
    positiveInteger(options.maxContentBytes, DEFAULTS.maxContentBytes, "maxContentBytes"),
    Math.max(256, maxViewBytes - 256),
  );
  const ephemeralIndices: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === "tool" && message.ephemeral) ephemeralIndices.push(index);
  });
  const keepEphemeral = new Set(ephemeralIndices.slice(-maxEphemeral));
  const filtered = messages.filter(
    (message, index) => message.role !== "tool" || !message.ephemeral || keepEphemeral.has(index),
  );
  const anchorIndex = filtered.findIndex((message) => message.role === "user");
  const anchor = anchorIndex >= 0 ? boundMessage(filtered[anchorIndex]!, maxContentBytes) : undefined;
  const rolling = filtered
    .filter((_, index) => index !== anchorIndex)
    .slice(-(anchor ? Math.max(0, maxMessages - 1) : maxMessages))
    .map((message) => boundMessage(message, maxContentBytes));
  let projected = anchor ? [anchor, ...rolling] : rolling;
  while (projected.length > (anchor ? 1 : 0) && Buffer.byteLength(JSON.stringify(projected), "utf8") > maxViewBytes) {
    projected.splice(anchor ? 1 : 0, 1);
  }
  return Object.freeze(projected);
}

/** Backwards-compatible unbounded (except ephemeral) projection helper. */
export function visibleMessages(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  return projectModelView(messages, {
    maxMessages: Math.max(1, messages.length),
    maxEphemeralMessages: 3,
  });
}

/** Legacy helper for callers that maintain their own mutable, non-audit history. */
export function pushToolResult(
  messages: ChatMessage[],
  tool: Tool,
  content: string,
  toolCallId = "manual",
): void {
  messages.push({
    role: "tool",
    content,
    toolCallId,
    toolName: tool.name,
    status: "success",
    ephemeral: tool.ephemeral,
  });
  const ephemeralIndices = messages
    .map((message, index) => (message.role === "tool" && message.ephemeral ? index : -1))
    .filter((index) => index >= 0);
  const drop = new Set(ephemeralIndices.slice(0, -3));
  for (let index = messages.length - 1; index >= 0; index--) {
    if (drop.has(index)) messages.splice(index, 1);
  }
}

/** A registered, schema-described terminal tool; no provider-specific fake is supplied. */
export function createDoneTool(name = "done"): Tool {
  return Object.freeze({
    name,
    description: "Complete the task with a final message.",
    terminal: true,
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: { message: { type: "string" } },
    }),
    async authorize() { return true; },
    async invoke(args: Readonly<Record<string, unknown>>): Promise<string> {
      if (typeof args.message !== "string") throw new TypeError("message must be a string");
      return args.message;
    },
  });
}

function feedback(code: "UNKNOWN_TOOL" | "TOOL_ERROR" | "PERMISSION_DENIED", message: string): string {
  return JSON.stringify({ error: { code, message } });
}

function resultContent(result: ToolResult): string {
  return typeof result === "string" ? result : result.content;
}

export async function runLoop(
  model: ChatModel,
  tools: readonly Tool[],
  initialMessages: readonly ChatMessage[],
  options: LoopOptions = {},
): Promise<LoopOutcome> {
  const maxTurns = positiveInteger(options.maxTurns, DEFAULTS.maxTurns, "maxTurns");
  const maxToolCalls = positiveInteger(options.maxToolCalls, DEFAULTS.maxToolCalls, "maxToolCalls");
  const maxNoProgress = positiveInteger(
    options.maxNoProgressTurns,
    DEFAULTS.maxNoProgressTurns,
    "maxNoProgressTurns",
  );
  const maxContentBytes = positiveInteger(options.maxContentBytes, DEFAULTS.maxContentBytes, "maxContentBytes");
  const maxInitialMessages = positiveInteger(options.maxMessages, DEFAULTS.maxMessages, "maxMessages");
  if (initialMessages.length > maxInitialMessages) throw new RangeError(`initialMessages exceeds ${maxInitialMessages}`);
  const now = options.now ?? Date.now;
  const deadline = options.deadline instanceof Date ? options.deadline.getTime() : options.deadline;
  if (deadline !== undefined && !Number.isFinite(deadline)) throw new RangeError("deadline must be finite");

  const trace: ChatMessage[] = initialMessages.map((message) => boundMessage(message, maxContentBytes));
  if (tools.length > 256) throw new RangeError("tool registry exceeds 256 entries");
  const registered = new Map<string, Tool>();
  for (const tool of tools) {
    if (registered.has(tool.name)) throw new Error(`Duplicate tool registration: ${tool.name}`);
    registered.set(tool.name, tool);
  }

  const controller = new AbortController();
  let deadlineExpired = deadline !== undefined && now() >= deadline;
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timeout = deadline === undefined
    ? undefined
    : setTimeout(() => {
        deadlineExpired = true;
        controller.abort(new Error("deadline exceeded"));
      }, Math.max(0, deadline - now()));

  let turns = 0;
  let toolCalls = 0;
  let noProgressTurns = 0;
  const usedCallIds = new Set<string>();

  const fail = (code: LoopErrorCode, message: string, cause?: unknown): never => {
    const audit = snapshot(trace);
    if (code === "ABORTED") throw new LoopAbortedError(code, message, audit, turns, toolCalls, { cause });
    if (code === "DEADLINE_EXCEEDED") {
      throw new LoopDeadlineError(code, message, audit, turns, toolCalls, { cause });
    }
    if (code === "MODEL_ERROR") {
      throw new ModelInvocationError(code, message, audit, turns, toolCalls, { cause });
    }
    throw new LoopBudgetError(code, message, audit, turns, toolCalls, { cause });
  };

  const checkCancellation = (): void => {
    if (deadlineExpired || (deadline !== undefined && now() >= deadline)) {
      deadlineExpired = true;
      fail("DEADLINE_EXCEEDED", "Agent loop deadline exceeded");
    }
    if (options.signal?.aborted || controller.signal.aborted) {
      fail("ABORTED", "Agent loop aborted", options.signal?.reason);
    }
  };

  // A provider/tool should honor the signal, but the loop budget must not depend on it doing so.
  const abortable = async <T>(work: Promise<T>): Promise<T> => {
    if (controller.signal.aborted) checkCancellation();
    return await new Promise<T>((resolve, reject) => {
      const aborted = () => reject(controller.signal.reason ?? new Error("aborted"));
      controller.signal.addEventListener("abort", aborted, { once: true });
      work.then(
        (value) => {
          controller.signal.removeEventListener("abort", aborted);
          resolve(value);
        },
        (error) => {
          controller.signal.removeEventListener("abort", aborted);
          reject(error);
        },
      );
    });
  };

  try {
    while (true) {
      checkCancellation();
      if (turns >= maxTurns) fail("MAX_TURNS", `Maximum turns exceeded (${maxTurns})`);

      const turn = turns + 1;
      let response: InvokeResult;
      try {
        response = await abortable(model.ainvoke(
          projectModelView(trace, options),
          tools,
          { signal: controller.signal, turn, deadline },
        ));
      } catch (error) {
        checkCancellation();
        response = fail("MODEL_ERROR", "Model invocation failed", error);
      }
      checkCancellation();
      if (
        typeof response?.text !== "string" ||
        !Array.isArray(response.toolCalls) ||
        response.toolCalls.some((call) =>
          !call || typeof call.name !== "string" || !call.args || typeof call.args !== "object"
        )
      ) {
        fail("MODEL_ERROR", "Model returned an invalid response");
      }
      turns = turn;
      if (response.toolCalls.length > maxToolCalls - toolCalls) {
        fail("MAX_TOOL_CALLS", `Maximum tool calls exceeded (${maxToolCalls})`);
      }

      const calls: ToolCall[] = response.toolCalls.map((call, index) => {
        if (Buffer.byteLength(JSON.stringify(call.args), "utf8") > maxContentBytes) {
          fail("MODEL_ERROR", `Tool arguments exceed ${maxContentBytes} bytes`);
        }
        let id = call.id?.trim() || `turn-${turn}-call-${index + 1}`;
        if (usedCallIds.has(id)) id = `turn-${turn}-call-${index + 1}`;
        while (usedCallIds.has(id)) id += "-duplicate";
        usedCallIds.add(id);
        return freezeValue({ id, name: call.name, args: cloneData(call.args) });
      });
      trace.push(freezeValue({ role: "assistant", content: boundedText(response.text, maxContentBytes), toolCalls: calls, turn }));

      let madeProgress = false;
      for (const call of calls) {
        checkCancellation();
        if (toolCalls >= maxToolCalls) {
          fail("MAX_TOOL_CALLS", `Maximum tool calls exceeded (${maxToolCalls})`);
        }
        toolCalls++;
        const tool = registered.get(call.name);
        if (!tool) {
          trace.push(freezeValue({
            role: "tool",
            content: feedback("UNKNOWN_TOOL", `Unknown tool: ${call.name}`),
            toolCallId: call.id,
            toolName: call.name,
            status: "error",
          }));
          continue;
        }

        try {
          const toolContext: ToolContext = {
            signal: controller.signal,
            toolCallId: call.id,
            turn,
            deadline,
          };
          if (!tool.authorize) throw new Error("tool_permission_dispatcher_required");
          const authorization = await abortable(tool.authorize(call.args, toolContext));
          const authorized = authorization === true
            || (typeof authorization === "object" && authorization.decision === "allow");
          if (!authorized) {
            const reason = typeof authorization === "object" && authorization.reason
              ? authorization.reason
              : "tool_permission_not_allowed";
            throw new Error(`tool_permission_not_allowed:${reason}`);
          }
          const result = await abortable(tool.invoke(call.args, toolContext));
          checkCancellation();
          const content = boundedText(resultContent(result), maxContentBytes);
          trace.push(freezeValue({
            role: "tool",
            content,
            toolCallId: call.id,
            toolName: call.name,
            status: "success",
            ephemeral: tool.ephemeral,
          }));
          madeProgress = true;
          if (tool.terminal) {
            return Object.freeze({
              status: "completed",
              result: content,
              terminalTool: tool.name,
              turns,
              toolCalls,
              trace: snapshot(trace),
            });
          }
        } catch (error) {
          checkCancellation();
          const permissionDenied = error instanceof Error && (
            error.message === "tool_permission_dispatcher_required"
            || error.message.startsWith("tool_permission_not_allowed:")
          );
          const message = permissionDenied ? "Tool permission denied" : (error instanceof Error ? error.name : "tool_error");
          trace.push(freezeValue({
            role: "tool",
            content: feedback(permissionDenied ? "PERMISSION_DENIED" : "TOOL_ERROR", boundedText(message, 256)),
            toolCallId: call.id,
            toolName: call.name,
            status: "error",
            ephemeral: tool.ephemeral,
          }));
        }
      }

      noProgressTurns = madeProgress ? 0 : noProgressTurns + 1;
      if (noProgressTurns >= maxNoProgress) {
        fail("NO_PROGRESS", `No progress for ${maxNoProgress} consecutive turns`);
      }
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
