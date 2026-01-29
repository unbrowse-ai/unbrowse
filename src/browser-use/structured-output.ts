/**
 * Browser-Use TypeScript Port - Structured Output
 *
 * Runtime validation for LLM outputs using simple schema definitions.
 * No external dependencies - lightweight alternative to Zod.
 */

export type SchemaType =
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "null"
  | "any";

export interface SchemaDefinition {
  type: SchemaType;
  optional?: boolean;
  description?: string;
  items?: SchemaDefinition; // For arrays
  properties?: Record<string, SchemaDefinition>; // For objects
  enum?: any[]; // Allowed values
  default?: any;
}

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: string[];
}

/**
 * Validate data against a schema
 */
export function validate<T>(
  data: unknown,
  schema: SchemaDefinition,
  path: string = ""
): ValidationResult<T> {
  const errors: string[] = [];

  function check(value: unknown, s: SchemaDefinition, p: string): unknown {
    // Handle null/undefined
    if (value === null || value === undefined) {
      if (s.optional) {
        return s.default ?? null;
      }
      errors.push(`${p || "root"}: required but got ${value}`);
      return null;
    }

    // Check enum values
    if (s.enum && !s.enum.includes(value)) {
      errors.push(`${p || "root"}: expected one of [${s.enum.join(", ")}] but got ${JSON.stringify(value)}`);
      return s.default ?? value;
    }

    // Type checking
    switch (s.type) {
      case "string":
        if (typeof value !== "string") {
          errors.push(`${p || "root"}: expected string but got ${typeof value}`);
          return String(value);
        }
        return value;

      case "number":
        if (typeof value !== "number") {
          const num = Number(value);
          if (isNaN(num)) {
            errors.push(`${p || "root"}: expected number but got ${typeof value}`);
            return s.default ?? 0;
          }
          return num;
        }
        return value;

      case "boolean":
        if (typeof value !== "boolean") {
          errors.push(`${p || "root"}: expected boolean but got ${typeof value}`);
          return Boolean(value);
        }
        return value;

      case "array":
        if (!Array.isArray(value)) {
          errors.push(`${p || "root"}: expected array but got ${typeof value}`);
          return s.default ?? [];
        }
        if (s.items) {
          return value.map((item, i) => check(item, s.items!, `${p}[${i}]`));
        }
        return value;

      case "object":
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          errors.push(`${p || "root"}: expected object but got ${typeof value}`);
          return s.default ?? {};
        }
        if (s.properties) {
          const result: Record<string, unknown> = {};
          for (const [key, propSchema] of Object.entries(s.properties)) {
            result[key] = check((value as Record<string, unknown>)[key], propSchema, `${p}.${key}`);
          }
          return result;
        }
        return value;

      case "null":
        if (value !== null) {
          errors.push(`${p || "root"}: expected null but got ${typeof value}`);
        }
        return null;

      case "any":
        return value;

      default:
        return value;
    }
  }

  const result = check(data, schema, path);

  return {
    success: errors.length === 0,
    data: result as T,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Create a schema builder for fluent API
 */
export const Schema = {
  string(opts?: { optional?: boolean; enum?: string[]; description?: string }): SchemaDefinition {
    return { type: "string", ...opts };
  },

  number(opts?: { optional?: boolean; description?: string }): SchemaDefinition {
    return { type: "number", ...opts };
  },

  boolean(opts?: { optional?: boolean; description?: string }): SchemaDefinition {
    return { type: "boolean", ...opts };
  },

  array(items: SchemaDefinition, opts?: { optional?: boolean; description?: string }): SchemaDefinition {
    return { type: "array", items, ...opts };
  },

  object(
    properties: Record<string, SchemaDefinition>,
    opts?: { optional?: boolean; description?: string }
  ): SchemaDefinition {
    return { type: "object", properties, ...opts };
  },

  any(opts?: { optional?: boolean; description?: string }): SchemaDefinition {
    return { type: "any", ...opts };
  },

  null(): SchemaDefinition {
    return { type: "null" };
  },
};

/**
 * Generate a JSON schema description for LLM prompting
 */
export function schemaToPrompt(schema: SchemaDefinition, indent: number = 0): string {
  const pad = "  ".repeat(indent);

  switch (schema.type) {
    case "string":
      let str = "string";
      if (schema.enum) str += ` (one of: ${schema.enum.join(", ")})`;
      if (schema.description) str += ` - ${schema.description}`;
      return str;

    case "number":
      return schema.description ? `number - ${schema.description}` : "number";

    case "boolean":
      return schema.description ? `boolean - ${schema.description}` : "boolean";

    case "array":
      if (schema.items) {
        return `array of:\n${pad}  - ${schemaToPrompt(schema.items, indent + 1)}`;
      }
      return "array";

    case "object":
      if (schema.properties) {
        const props = Object.entries(schema.properties)
          .map(([key, prop]) => {
            const optional = prop.optional ? " (optional)" : "";
            return `${pad}  "${key}"${optional}: ${schemaToPrompt(prop, indent + 1)}`;
          })
          .join("\n");
        return `object:\n${props}`;
      }
      return "object";

    default:
      return schema.type;
  }
}

/**
 * Parse LLM response and validate against schema
 */
export function parseAndValidate<T>(
  response: string,
  schema: SchemaDefinition
): ValidationResult<T> {
  // Try to extract JSON from response
  const jsonPatterns = [
    /```json\s*([\s\S]*?)\s*```/, // Markdown code block
    /```\s*([\s\S]*?)\s*```/, // Generic code block
    /(\{[\s\S]*\})/, // Raw JSON object
    /(\[[\s\S]*\])/, // Raw JSON array
  ];

  let jsonStr: string | null = null;

  for (const pattern of jsonPatterns) {
    const match = response.match(pattern);
    if (match) {
      jsonStr = match[1];
      break;
    }
  }

  if (!jsonStr) {
    return {
      success: false,
      errors: ["No JSON found in response"],
    };
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    // Try to repair common JSON issues
    try {
      // Remove trailing commas
      const repaired = jsonStr
        .replace(/,\s*([\]}])/g, "$1")
        .replace(/'/g, '"');
      parsed = JSON.parse(repaired);
    } catch {
      return {
        success: false,
        errors: [`Invalid JSON: ${(e as Error).message}`],
      };
    }
  }

  // Validate against schema
  return validate<T>(parsed, schema);
}

// Common schemas for browser automation
export const CommonSchemas = {
  /**
   * Schema for extracted product data
   */
  product: Schema.object({
    name: Schema.string({ description: "Product name" }),
    price: Schema.string({ optional: true, description: "Price including currency" }),
    description: Schema.string({ optional: true, description: "Product description" }),
    url: Schema.string({ optional: true, description: "Product URL" }),
    imageUrl: Schema.string({ optional: true, description: "Product image URL" }),
    rating: Schema.number({ optional: true, description: "Rating out of 5" }),
    reviews: Schema.number({ optional: true, description: "Number of reviews" }),
  }),

  /**
   * Schema for extracted link data
   */
  link: Schema.object({
    text: Schema.string({ description: "Link text" }),
    url: Schema.string({ description: "Link URL" }),
    isExternal: Schema.boolean({ optional: true }),
  }),

  /**
   * Schema for search results
   */
  searchResult: Schema.object({
    title: Schema.string({ description: "Result title" }),
    url: Schema.string({ description: "Result URL" }),
    snippet: Schema.string({ optional: true, description: "Result description/snippet" }),
  }),

  /**
   * Schema for form field data
   */
  formField: Schema.object({
    name: Schema.string({ description: "Field name or label" }),
    type: Schema.string({ enum: ["text", "email", "password", "number", "select", "checkbox", "radio", "textarea"] }),
    value: Schema.string({ optional: true, description: "Current value" }),
    required: Schema.boolean({ optional: true }),
    options: Schema.array(Schema.string(), { optional: true, description: "Options for select/radio" }),
  }),
};
