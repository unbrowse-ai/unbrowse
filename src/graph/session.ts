import type {
  SkillOperationGraph,
  SkillOperationNode,
  OperationBinding,
} from "../types/index.js";

/** Result of matching a captured request against the operation graph. */
export interface IndexedOperation {
  operation_id: string;
  method: string;
  url_template: string;
  /** Binding values extracted from the matched response body. */
  extracted_bindings: Record<string, unknown>;
}

/** A single entry in the session execution trace. */
export interface TraceEntry {
  operationId: string;
  success: boolean;
  timestamp: string;
}

/**
 * Build a regex from a url_template by replacing `{param}` with a capture-all segment pattern.
 * E.g. "https://api.example.com/users/{user_id}/posts" -> /^https:\/\/api\.example\.com\/users\/[^\/]+\/posts$/
 */
function templateToRegex(urlTemplate: string): RegExp {
  // Escape regex-special chars, then replace escaped \{...\} placeholders with [^/]+
  const escaped = urlTemplate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\\\{[^}]+\\\}/g, "[^/]+");
  // Allow optional trailing query string
  return new RegExp(`^${pattern}(\\?.*)?$`);
}

/**
 * Check whether an operation is runnable given a set of known bindings.
 * Re-implemented locally to avoid depending on a non-exported function in graph/index.ts.
 */
function isRunnable(
  operation: SkillOperationNode,
  bindings: Record<string, unknown>,
): boolean {
  return operation.requires.every((binding) => {
    if (!binding.required) return true;
    const value = bindings[binding.key];
    return value != null && value !== "";
  });
}

/**
 * Try to extract binding values from a JSON response body for a given set of `provides` bindings.
 * Walks top-level and one-level-nested keys looking for matches against binding keys.
 */
function extractBindingsFromJson(
  responseBody: string | undefined,
  provides: OperationBinding[],
): Record<string, unknown> {
  if (!responseBody) return {};
  const extracted: Record<string, unknown> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return extracted;
  }
  if (typeof parsed !== "object" || parsed === null) return extracted;

  const provideKeys = new Set(provides.map((b) => b.key));

  function walkObject(obj: Record<string, unknown>, depth: number): void {
    for (const [key, value] of Object.entries(obj)) {
      if (provideKeys.has(key) && value != null && value !== "") {
        // For arrays/objects, store the value directly; for scalars, store as-is
        extracted[key] = value;
      }
      // Walk one level deep into nested objects (not arrays)
      if (
        depth === 0 &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        walkObject(value as Record<string, unknown>, depth + 1);
      }
      // For arrays, check first element
      if (depth === 0 && Array.isArray(value) && value.length > 0) {
        const first = value[0];
        if (typeof first === "object" && first !== null) {
          // Check if array items have keys matching provides
          for (const itemKey of Object.keys(first as Record<string, unknown>)) {
            if (provideKeys.has(itemKey)) {
              const itemValue = (first as Record<string, unknown>)[itemKey];
              if (itemValue != null && itemValue !== "") {
                extracted[itemKey] = itemValue;
              }
            }
          }
        }
      }
    }
  }

  walkObject(parsed as Record<string, unknown>, 0);
  return extracted;
}

/**
 * Session-scoped graph index that tracks observed requests and binding state.
 * Ephemeral — lives for the duration of one action sequence, not persisted.
 */
export class GraphSession {
  private graph: SkillOperationGraph;
  private observedOperations = new Map<
    string,
    { timestamp: string; extracted: Record<string, unknown> }
  >();
  private executedOperations = new Map<
    string,
    { success: boolean; timestamp: string; responseFields?: string[] }
  >();
  private knownBindings: Record<string, unknown> = {};
  private trace: TraceEntry[] = [];
  private templateCache: Array<{
    operation: SkillOperationNode;
    regex: RegExp;
  }>;

  constructor(graph: SkillOperationGraph) {
    this.graph = graph;
    // Pre-compile URL template regexes for fast matching
    this.templateCache = graph.operations.map((op) => ({
      operation: op,
      regex: templateToRegex(op.url_template),
    }));
  }

  /**
   * Index a captured request against the graph — match it to an operation.
   * Returns the matched operation info, or null if no match.
   */
  indexRequest(request: {
    url: string;
    method: string;
    response_body?: string;
  }): IndexedOperation | null {
    for (const { operation, regex } of this.templateCache) {
      if (
        operation.method === request.method &&
        regex.test(request.url)
      ) {
        // Extract bindings from the response body
        const extracted = extractBindingsFromJson(
          request.response_body,
          operation.provides,
        );

        // Mark as observed
        this.observedOperations.set(operation.operation_id, {
          timestamp: new Date().toISOString(),
          extracted,
        });

        // Merge extracted bindings into known state
        for (const [key, value] of Object.entries(extracted)) {
          if (value != null && value !== "") {
            this.knownBindings[key] = value;
          }
        }

        return {
          operation_id: operation.operation_id,
          method: operation.method,
          url_template: operation.url_template,
          extracted_bindings: extracted,
        };
      }
    }
    return null;
  }

  /** Get bindings that are now known from indexed responses. */
  getKnownBindings(): Record<string, unknown> {
    return { ...this.knownBindings };
  }

  /** Get operations that are now runnable given known bindings. */
  getRunnableOperations(): SkillOperationNode[] {
    return this.graph.operations.filter((op) =>
      isRunnable(op, this.knownBindings),
    );
  }

  /**
   * Get the next suggested operations (unblocked by current state).
   * Excludes already-executed and already-observed operations.
   * If targetOperationId is provided, includes ops that would become runnable
   * after the target completes (considering its provides).
   */
  getSuggestedNext(targetOperationId?: string): SkillOperationNode[] {
    const seen = new Set([
      ...this.observedOperations.keys(),
      ...this.executedOperations.keys(),
    ]);

    // Build effective bindings: current known + target's provides if specified
    let effectiveBindings = { ...this.knownBindings };
    if (targetOperationId) {
      const targetOp = this.graph.operations.find(
        (op) => op.operation_id === targetOperationId,
      );
      if (targetOp) {
        for (const binding of targetOp.provides) {
          if (effectiveBindings[binding.key] == null) {
            // Mark as "will be available" with a placeholder
            effectiveBindings[binding.key] = binding.example_value ?? "__pending__";
          }
        }
      }
    }

    // Find reachable operations from observed/executed nodes via edges
    const reachableFromObserved = new Set<string>();
    for (const edge of this.graph.edges) {
      if (
        this.observedOperations.has(edge.from_operation_id) ||
        this.executedOperations.has(edge.from_operation_id) ||
        edge.from_operation_id === targetOperationId
      ) {
        reachableFromObserved.add(edge.to_operation_id);
      }
    }
    // Entry operations are always reachable
    for (const entryId of this.graph.entry_operation_ids) {
      reachableFromObserved.add(entryId);
    }

    return this.graph.operations.filter((op) => {
      if (seen.has(op.operation_id)) return false;
      if (op.operation_id === targetOperationId) return false;
      // Must be reachable from an observed node or be an entry
      if (!reachableFromObserved.has(op.operation_id)) return false;
      return isRunnable(op, effectiveBindings);
    });
  }

  /** Record that an operation was explicitly executed. */
  recordExecution(
    operationId: string,
    success: boolean,
    responseFields?: string[],
  ): void {
    const timestamp = new Date().toISOString();
    this.executedOperations.set(operationId, {
      success,
      timestamp,
      responseFields,
    });
    this.trace.push({ operationId, success, timestamp });

    // If successful and responseFields provided, mark those bindings as known
    if (success && responseFields) {
      const op = this.graph.operations.find(
        (o) => o.operation_id === operationId,
      );
      if (op) {
        for (const field of responseFields) {
          const binding = op.provides.find((b) => b.key === field);
          if (binding) {
            this.knownBindings[field] =
              binding.example_value ?? `__from_${operationId}__`;
          }
        }
      }
    }
  }

  /** Get session trace (ordered list of executed operations). */
  getTrace(): TraceEntry[] {
    return [...this.trace];
  }

  /** Serialize session state for inclusion in CaptureResult. */
  toSnapshot(): {
    observed_operations: string[];
    known_bindings: Record<string, unknown>;
    suggested_next: string[];
  } {
    return {
      observed_operations: [...this.observedOperations.keys()],
      known_bindings: this.getKnownBindings(),
      suggested_next: this.getSuggestedNext().map((op) => op.operation_id),
    };
  }
}
