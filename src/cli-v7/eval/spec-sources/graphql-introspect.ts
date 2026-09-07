/**
 * GraphQL introspection source for W22 `unbrowse eval spec`.
 *
 * Opt-in only — some sites disable introspection in production; some
 * treat it as adversarial reconnaissance. We fire ONLY when the caller
 * passes `--graphql`.
 *
 * Pointer discipline: we surface type NAMES only — never sample data,
 * never resolver source.
 */
export interface GraphqlHit {
  readonly source: "graphql";
  readonly url: string;
  readonly query_type: string | null;
  readonly mutation_type: string | null;
  readonly type_count: number;
  /** Type names only. */
  readonly types: string[];
}

const INTROSPECTION_QUERY = JSON.stringify({
  query: "{__schema{queryType{name} mutationType{name} types{name kind}}}",
});

export async function probeGraphqlIntrospection(
  url: string,
  budgetMs: number,
): Promise<GraphqlHit | null> {
  const originHost = (() => {
    try { return new URL(url).host; } catch { return ""; }
  })();
  if (!originHost) return null;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), budgetMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: INTROSPECTION_QUERY,
      redirect: "manual", // do not follow any redirect on POST
      signal: ctrl.signal,
    });
    if (resp.status !== 200) return null;
    let doc: unknown;
    try {
      doc = await resp.json();
    } catch {
      return null;
    }
    if (!doc || typeof doc !== "object") return null;
    const data = (doc as Record<string, unknown>).data;
    if (!data || typeof data !== "object") return null;
    const schema = (data as Record<string, unknown>).__schema;
    if (!schema || typeof schema !== "object") return null;
    const sObj = schema as Record<string, unknown>;

    const queryType = sObj.queryType && typeof sObj.queryType === "object"
      ? (sObj.queryType as Record<string, unknown>).name
      : null;
    const mutationType = sObj.mutationType && typeof sObj.mutationType === "object"
      ? (sObj.mutationType as Record<string, unknown>).name
      : null;
    const typesRaw = Array.isArray(sObj.types) ? sObj.types : [];
    const types: string[] = [];
    for (const tr of typesRaw) {
      if (tr && typeof tr === "object") {
        const trObj = tr as Record<string, unknown>;
        if (typeof trObj.name === "string" && !trObj.name.startsWith("__")) {
          types.push(trObj.name);
        }
      }
    }

    return {
      source: "graphql",
      url,
      query_type: typeof queryType === "string" ? queryType : null,
      mutation_type: typeof mutationType === "string" ? mutationType : null,
      type_count: types.length,
      types,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
