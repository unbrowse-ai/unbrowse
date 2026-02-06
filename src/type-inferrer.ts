/**
 * Type Inferrer — Generate TypeScript interfaces from observed API traffic.
 *
 * Analyzes endpoint groups (with their request/response body schemas) and
 * produces real TypeScript interfaces, turning `Promise<unknown>` into
 * `Promise<User>`, `Promise<Order[]>`, etc.
 *
 * Integrates with the endpoint analyzer's schema data (Record<string, string>
 * from schema-inferrer) and produces a TypeMap that the skill generator uses
 * to emit typed API client methods.
 */

import type { EndpointGroup } from "./types.js";

// ── Public types ─────────────────────────────────────────────────────────

export interface InferredField {
  name: string;
  /** TypeScript type string (e.g., "string", "number", "boolean", "string[]", "Address") */
  type: string;
  optional: boolean;
  nullable: boolean;
  /** Is this an ID/foreign key field */
  isId: boolean;
  /** If this is a nested object, the interface name it references */
  nestedType?: string;
  /** JSDoc comment (e.g., for date fields) */
  comment?: string;
}

export interface InferredInterface {
  /** Interface name (e.g., "User", "Order", "CreateUserRequest") */
  name: string;
  /** Which endpoint this was inferred from */
  sourceEndpoint: string;
  /** Whether this is a request body type or response type */
  kind: "request" | "response" | "entity";
  /** The interface fields */
  fields: InferredField[];
}

export interface TypeMap {
  /** All generated interfaces */
  interfaces: InferredInterface[];
  /** Map from endpoint key ("GET /users/{userId}") to its types */
  endpointTypes: Record<string, { requestType?: string; responseType?: string }>;
  /** The generated .d.ts file content */
  declarationFile: string;
}

// ── ID field detection ───────────────────────────────────────────────────

const ID_FIELD_EXACT = new Set(["id", "_id", "ID", "Id"]);
const ID_FIELD_SUFFIXES = ["Id", "_id", "ID", "Uuid", "_uuid"];

function isIdField(name: string): boolean {
  if (ID_FIELD_EXACT.has(name)) return true;
  return ID_FIELD_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

// ── Date field detection ─────────────────────────────────────────────────

const DATE_FIELD_EXACT = new Set([
  "date", "timestamp", "expires", "created", "updated",
  "created_at", "updated_at", "createdAt", "updatedAt",
  "deleted_at", "deletedAt", "published_at", "publishedAt",
  "started_at", "startedAt", "ended_at", "endedAt",
  "expires_at", "expiresAt", "expired_at", "expiredAt",
  "last_login", "lastLogin", "last_seen", "lastSeen",
  "modified_at", "modifiedAt",
]);
const DATE_FIELD_SUFFIXES = ["_at", "_date", "At", "Date", "Time", "_time"];

function isDateField(name: string): boolean {
  if (DATE_FIELD_EXACT.has(name)) return true;
  return DATE_FIELD_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

// ── Schema type → TypeScript type mapping ────────────────────────────────

/**
 * Map a schema type string (from schema-inferrer) to a TypeScript type.
 *
 * Schema types come as: "string", "number", "boolean", "null", "object",
 * "array", "array<string>", "array<number>", "array<object>", "mixed".
 */
function schemaTypeToTs(
  schemaType: string,
  fieldName: string,
  entityName: string,
  nestedInterfaces: InferredInterface[],
  sourceEndpoint: string,
  nestedSchema?: Record<string, string>,
): { tsType: string; nestedType?: string } {
  switch (schemaType) {
    case "string":
      return { tsType: "string" };
    case "number":
      return { tsType: "number" };
    case "boolean":
      return { tsType: "boolean" };
    case "null":
      return { tsType: "null" };
    case "mixed":
      return { tsType: "unknown" };
    case "array":
      return { tsType: "unknown[]" };
    case "array<string>":
      return { tsType: "string[]" };
    case "array<number>":
      return { tsType: "number[]" };
    case "array<boolean>":
      return { tsType: "boolean[]" };
    case "array<null>":
      return { tsType: "null[]" };
    case "array<object>": {
      // Generate a sub-interface for array items
      const itemName = toPascalCase(singularize(fieldName)) || "Item";
      const subInterfaceName = `${entityName}${itemName}`;
      // If we have nested schema data for this field, generate the sub-interface
      if (nestedSchema && Object.keys(nestedSchema).length > 0) {
        const subFields = schemaToFields(
          nestedSchema,
          subInterfaceName,
          nestedInterfaces,
          sourceEndpoint,
        );
        nestedInterfaces.push({
          name: subInterfaceName,
          sourceEndpoint,
          kind: "entity",
          fields: subFields,
        });
      }
      return { tsType: `${subInterfaceName}[]`, nestedType: subInterfaceName };
    }
    case "object": {
      if (nestedSchema && Object.keys(nestedSchema).length > 0) {
        const nestedName = `${entityName}${toPascalCase(fieldName)}`;
        const subFields = schemaToFields(
          nestedSchema,
          nestedName,
          nestedInterfaces,
          sourceEndpoint,
        );
        nestedInterfaces.push({
          name: nestedName,
          sourceEndpoint,
          kind: "entity",
          fields: subFields,
        });
        return { tsType: nestedName, nestedType: nestedName };
      }
      return { tsType: "Record<string, unknown>" };
    }
    default: {
      // Handle "array<...>" for any other inner type
      const arrayMatch = schemaType.match(/^array<(.+)>$/);
      if (arrayMatch) {
        const innerResult = schemaTypeToTs(
          arrayMatch[1], fieldName, entityName,
          nestedInterfaces, sourceEndpoint, nestedSchema,
        );
        return { tsType: `${innerResult.tsType}[]`, nestedType: innerResult.nestedType };
      }
      return { tsType: "unknown" };
    }
  }
}

// ── Naming helpers ───────────────────────────────────────────────────────

/** PascalCase from a segment: "user-profile" → "UserProfile", "userId" → "UserId" */
function toPascalCase(s: string): string {
  if (!s) return "";
  return s
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/** Singularize a simple English noun (best-effort, matching endpoint-analyzer). */
function singularize(word: string): string {
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("ses") || word.endsWith("xes") || word.endsWith("zes"))
    return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/**
 * Extract the entity name from a normalized path.
 * Uses the last non-parameter path segment, singularized and PascalCased.
 *
 * GET /users → "User"
 * GET /users/{userId}/orders → "Order"
 * POST /api/v1/products → "Product"
 */
function extractEntityName(normalizedPath: string): string {
  const segments = normalizedPath
    .split("/")
    .filter(Boolean)
    .filter((s) => !/^(api|v\d+)$/i.test(s));

  // Walk backwards to find the last non-param segment
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!segments[i].startsWith("{")) {
      return toPascalCase(singularize(segments[i]));
    }
  }

  return "Resource";
}

/**
 * Determine the response type name for an endpoint.
 *
 * - Single item responses (path ends with param): EntityName (e.g., "User")
 * - Array list responses (path ends with resource): EntityName + "ListResponse"
 *   unless the response is a simple array, in which case just EntityName + "[]"
 */
function deriveResponseTypeName(
  method: string,
  normalizedPath: string,
  responseSummary: string,
  responseSchema: Record<string, string> | undefined,
): { typeName: string; isList: boolean; isWrapped: boolean } {
  const entity = extractEntityName(normalizedPath);
  const segments = normalizedPath.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  const endsWithParam = lastSegment?.startsWith("{") ?? false;

  // Detect if response is a direct array
  const isArray = responseSummary.startsWith("array");

  // Detect if array is wrapped in an object (e.g., { data: [...], total: 3 })
  const isWrapped = !isArray && responseSchema
    ? Object.values(responseSchema).some((t) => t.startsWith("array"))
    : false;

  if (method === "GET" && !endsWithParam && (isArray || isWrapped)) {
    if (isWrapped) {
      return { typeName: `${entity}ListResponse`, isList: true, isWrapped: true };
    }
    // Direct array — the response type is just EntityName[]
    return { typeName: entity, isList: true, isWrapped: false };
  }

  return { typeName: entity, isList: false, isWrapped: false };
}

/**
 * Determine the request body type name for an endpoint.
 *
 * POST → "CreateEntityRequest"
 * PUT  → "UpdateEntityRequest"
 * PATCH → "UpdateEntityRequest"
 */
function deriveRequestTypeName(method: string, normalizedPath: string): string {
  const entity = extractEntityName(normalizedPath);
  switch (method.toUpperCase()) {
    case "POST":
      return `Create${entity}Request`;
    case "PUT":
    case "PATCH":
      return `Update${entity}Request`;
    default:
      return `${entity}Request`;
  }
}

// ── Schema → Fields conversion ───────────────────────────────────────────

/**
 * Extract nested sub-schema for a given field prefix from a flat schema.
 *
 * Schema-inferrer produces flat keys with dot notation for nested fields:
 *   { "address.street": "string", "address.city": "string" }
 *
 * This extracts the sub-schema for "address":
 *   { "street": "string", "city": "string" }
 */
function extractNestedSchema(
  schema: Record<string, string>,
  fieldName: string,
): Record<string, string> | undefined {
  const prefix = `${fieldName}.`;
  const nested: Record<string, string> = {};
  let found = false;

  for (const [key, type] of Object.entries(schema)) {
    if (key.startsWith(prefix)) {
      // Only take direct children (one level deep)
      const remainder = key.slice(prefix.length);
      if (!remainder.includes(".")) {
        nested[remainder] = type;
        found = true;
      }
    }
  }

  return found ? nested : undefined;
}

/**
 * Also extract nested schema for array items using "[]." prefix notation
 * from schema-inferrer's extractFields.
 *
 *   { "[].id": "string", "[].name": "string" } → { "id": "string", "name": "string" }
 */
function extractArrayItemSchema(
  schema: Record<string, string>,
  fieldName: string,
): Record<string, string> | undefined {
  // Check for "fieldName[].childField" pattern
  const prefix = `${fieldName}[].`;
  const nested: Record<string, string> = {};
  let found = false;

  for (const [key, type] of Object.entries(schema)) {
    if (key.startsWith(prefix)) {
      const remainder = key.slice(prefix.length);
      if (!remainder.includes(".")) {
        nested[remainder] = type;
        found = true;
      }
    }
  }

  return found ? nested : undefined;
}

/**
 * Convert a flat schema Record<string, string> into InferredField[].
 * Only processes top-level fields (no dots in key).
 */
function schemaToFields(
  schema: Record<string, string>,
  entityName: string,
  nestedInterfaces: InferredInterface[],
  sourceEndpoint: string,
): InferredField[] {
  const fields: InferredField[] = [];

  for (const [key, schemaType] of Object.entries(schema)) {
    // Skip nested keys (contain dots or array brackets) — they are handled via extractNestedSchema
    if (key.includes(".") || key.startsWith("[]")) continue;

    const isId = isIdField(key);
    const isDate = isDateField(key);

    // Look for nested object data
    const nestedSchema = schemaType === "object"
      ? extractNestedSchema(schema, key)
      : schemaType === "array<object>"
        ? extractArrayItemSchema(schema, key)
        : undefined;

    const { tsType, nestedType } = schemaTypeToTs(
      schemaType, key, entityName,
      nestedInterfaces, sourceEndpoint, nestedSchema,
    );

    // Override ID field type: if the field is an ID, keep its schema type
    // but note it for documentation
    const finalType = isId && schemaType === "number" ? "number" : tsType;

    fields.push({
      name: key,
      type: finalType,
      optional: false, // Default to required; callers can override
      nullable: false,
      isId,
      nestedType,
      comment: isDate ? "ISO 8601 date string" : undefined,
    });
  }

  return fields;
}

// ── Deduplication ────────────────────────────────────────────────────────

/**
 * Ensure all interface names are unique. If "User" already exists,
 * the second one becomes "User2", etc.
 */
function deduplicateNames(interfaces: InferredInterface[]): void {
  const seen = new Map<string, number>();

  for (const iface of interfaces) {
    const count = seen.get(iface.name) ?? 0;
    if (count > 0) {
      iface.name = `${iface.name}${count + 1}`;
    }
    seen.set(iface.name.replace(/\d+$/, ""), count + 1);
  }
}

/**
 * Merge duplicate interfaces that have the same name and compatible fields.
 * When the same entity appears from multiple endpoints (e.g., GET /users and
 * GET /users/{userId} both return User), merge their fields into one.
 */
function mergeCompatibleInterfaces(interfaces: InferredInterface[]): InferredInterface[] {
  const byName = new Map<string, InferredInterface>();
  const result: InferredInterface[] = [];

  for (const iface of interfaces) {
    const existing = byName.get(iface.name);
    if (!existing) {
      byName.set(iface.name, iface);
      result.push(iface);
      continue;
    }

    // Same name + same kind + compatible fields → merge
    if (existing.kind === iface.kind) {
      const existingFieldNames = new Set(existing.fields.map((f) => f.name));
      for (const field of iface.fields) {
        if (!existingFieldNames.has(field.name)) {
          // New field that only appeared in some responses → optional
          field.optional = true;
          existing.fields.push(field);
        }
      }
      // Fields in existing but not in new → mark optional
      const newFieldNames = new Set(iface.fields.map((f) => f.name));
      for (const field of existing.fields) {
        if (!newFieldNames.has(field.name)) {
          field.optional = true;
        }
      }
    } else {
      // Different kind — deduplicate name
      let counter = 2;
      while (byName.has(`${iface.name}${counter}`)) counter++;
      iface.name = `${iface.name}${counter}`;
      byName.set(iface.name, iface);
      result.push(iface);
    }
  }

  return result;
}

// ── Declaration file generation ──────────────────────────────────────────

/**
 * Render a single interface as a TypeScript declaration string.
 */
function renderInterface(iface: InferredInterface): string {
  if (iface.fields.length === 0) {
    return `export interface ${iface.name} {\n  [key: string]: unknown;\n}`;
  }

  const fieldLines: string[] = [];
  for (const field of iface.fields) {
    // JSDoc comment
    if (field.comment) {
      fieldLines.push(`  /** ${field.comment} */`);
    }

    const optional = field.optional ? "?" : "";
    const nullable = field.nullable ? " | null" : "";
    fieldLines.push(`  ${field.name}${optional}: ${field.type}${nullable};`);
  }

  return `export interface ${iface.name} {\n${fieldLines.join("\n")}\n}`;
}

/**
 * Generate a .d.ts file content string from a TypeMap.
 */
export function generateDeclarationFile(
  typeMap: TypeMap,
  serviceName: string,
): string {
  const title = serviceName
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  const blocks: string[] = [];
  blocks.push(`/** Auto-generated types for ${title}Api -- inferred from captured API traffic */`);
  blocks.push("");

  for (const iface of typeMap.interfaces) {
    blocks.push(renderInterface(iface));
    blocks.push("");
  }

  return blocks.join("\n");
}

// ── Main export ──────────────────────────────────────────────────────────

/**
 * Generate TypeScript interfaces from endpoint groups.
 *
 * Walks through all endpoint groups, inspects their request/response body
 * schemas, and produces named TypeScript interfaces for each.
 *
 * @param endpointGroups - Analyzed endpoint groups from endpoint-analyzer
 * @param serviceName - Service name for the generated declaration file header
 * @returns TypeMap with all interfaces, endpoint type mappings, and .d.ts content
 */
export function inferTypes(
  endpointGroups: EndpointGroup[],
  serviceName: string,
): TypeMap {
  const allInterfaces: InferredInterface[] = [];
  const endpointTypes: Record<string, { requestType?: string; responseType?: string }> = {};

  for (const ep of endpointGroups) {
    const endpointKey = `${ep.method} ${ep.normalizedPath}`;
    const entityName = extractEntityName(ep.normalizedPath);
    const typeEntry: { requestType?: string; responseType?: string } = {};

    // ── Response type ──────────────────────────────────────────────────
    if (ep.responseBodySchema && Object.keys(ep.responseBodySchema).length > 0) {
      const { typeName, isList, isWrapped } = deriveResponseTypeName(
        ep.method,
        ep.normalizedPath,
        ep.responseSummary || "",
        ep.responseBodySchema,
      );

      if (isWrapped) {
        // Wrapped list response: generate both the wrapper and the entity
        // e.g., { data: User[], total: number } → UserListResponse + User

        // Find which field is the array
        const arrayField = Object.entries(ep.responseBodySchema).find(
          ([, type]) => type.startsWith("array"),
        );
        const arrayFieldName = arrayField?.[0] ?? "data";

        // Generate entity interface from array items if we have nested data
        const itemSchema = extractArrayItemSchema(ep.responseBodySchema, arrayFieldName);
        if (itemSchema && Object.keys(itemSchema).length > 0) {
          const entityFields = schemaToFields(
            itemSchema, entityName, allInterfaces, endpointKey,
          );
          allInterfaces.push({
            name: entityName,
            sourceEndpoint: endpointKey,
            kind: "entity",
            fields: entityFields,
          });
        }

        // Generate wrapper interface
        const wrapperFields: InferredField[] = [];
        for (const [key, schemaType] of Object.entries(ep.responseBodySchema)) {
          if (key.includes(".") || key.startsWith("[]")) continue;
          if (key === arrayFieldName) {
            wrapperFields.push({
              name: key,
              type: `${entityName}[]`,
              optional: false,
              nullable: false,
              isId: false,
              nestedType: entityName,
            });
          } else {
            const { tsType } = schemaTypeToTs(
              schemaType, key, typeName,
              allInterfaces, endpointKey,
            );
            wrapperFields.push({
              name: key,
              type: tsType,
              optional: false,
              nullable: false,
              isId: isIdField(key),
              comment: isDateField(key) ? "ISO 8601 date string" : undefined,
            });
          }
        }

        allInterfaces.push({
          name: typeName,
          sourceEndpoint: endpointKey,
          kind: "response",
          fields: wrapperFields,
        });

        typeEntry.responseType = typeName;
      } else if (isList) {
        // Direct array response — generate the entity interface
        // The return type will be `EntityName[]`

        // For direct arrays, the schema keys might be prefixed with "[]."
        // from schema-inferrer's extractFields. Check for that pattern.
        const arrayItemSchema = extractArrayItemSchema(ep.responseBodySchema, "");
        const schemaToUse = arrayItemSchema && Object.keys(arrayItemSchema).length > 0
          ? arrayItemSchema
          : ep.responseBodySchema;

        const fields = schemaToFields(
          schemaToUse, typeName, allInterfaces, endpointKey,
        );

        if (fields.length > 0) {
          allInterfaces.push({
            name: typeName,
            sourceEndpoint: endpointKey,
            kind: "entity",
            fields,
          });
        }

        // Type is Entity[] but we register just the entity name
        typeEntry.responseType = `${typeName}[]`;
      } else {
        // Single object response
        const fields = schemaToFields(
          ep.responseBodySchema, typeName, allInterfaces, endpointKey,
        );

        if (fields.length > 0) {
          allInterfaces.push({
            name: typeName,
            sourceEndpoint: endpointKey,
            kind: "response",
            fields,
          });
        }

        typeEntry.responseType = typeName;
      }
    }

    // ── Request body type ──────────────────────────────────────────────
    if (
      ep.requestBodySchema &&
      Object.keys(ep.requestBodySchema).length > 0 &&
      (ep.method === "POST" || ep.method === "PUT" || ep.method === "PATCH")
    ) {
      const requestTypeName = deriveRequestTypeName(ep.method, ep.normalizedPath);

      const fields = schemaToFields(
        ep.requestBodySchema, requestTypeName, allInterfaces, endpointKey,
      );

      if (fields.length > 0) {
        allInterfaces.push({
          name: requestTypeName,
          sourceEndpoint: endpointKey,
          kind: "request",
          fields,
        });
      }

      typeEntry.requestType = requestTypeName;
    }

    endpointTypes[endpointKey] = typeEntry;
  }

  // ── Post-processing ──────────────────────────────────────────────────
  const merged = mergeCompatibleInterfaces(allInterfaces);
  deduplicateNames(merged);

  // Update endpointTypes to reflect any name changes from deduplication
  // (names are stable after mergeCompatibleInterfaces + deduplicateNames)

  const typeMap: TypeMap = {
    interfaces: merged,
    endpointTypes,
    declarationFile: "", // filled below
  };

  typeMap.declarationFile = generateDeclarationFile(typeMap, serviceName);

  return typeMap;
}
