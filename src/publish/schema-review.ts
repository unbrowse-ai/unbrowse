import { sanitizeAgentVisibleValue } from "./sanitize.js";
import type {
  EndpointParameterReview,
  EndpointResponseFieldReview,
  EndpointReviewPayload,
  OperationBinding,
  ResponseSchema,
  WorkflowArtifact,
  WorkflowParameterConstraint,
  WorkflowParameterSpec,
} from "../types/index.js";

function tokenizeSchemaPath(path: string): string[] {
  const tokens: string[] = [];
  for (const segment of path.split(".").filter(Boolean)) {
    const matches = segment.match(/([^[\]]+)|\[\]/g);
    if (matches) tokens.push(...matches);
  }
  return tokens;
}

function getSchemaNode(schema: ResponseSchema | undefined, path: string): ResponseSchema | null {
  if (!schema) return null;
  const tokens = tokenizeSchemaPath(path);
  let node: ResponseSchema | undefined = schema;
  for (const token of tokens) {
    if (!node) return null;
    node = token === "[]"
      ? node.items
      : node.properties?.[token];
  }
  return node ?? null;
}

export function flattenResponseSchemaFields(
  schema?: ResponseSchema,
  prefix = "",
  required = false,
): Array<{
  path: string;
  type: string;
  required: boolean;
  description?: string;
  enum_values?: Array<string | number | boolean>;
}> {
  if (!schema) return [];
  const rows: Array<{
    path: string;
    type: string;
    required: boolean;
    description?: string;
    enum_values?: Array<string | number | boolean>;
  }> = [];

  if (prefix) {
    rows.push({
      path: prefix,
      type: schema.type,
      required,
      ...(schema.description ? { description: schema.description } : {}),
      ...(schema.enum_values?.length ? { enum_values: schema.enum_values } : {}),
    });
  }

  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    rows.push(...flattenResponseSchemaFields(child, childPath, (schema.required ?? []).includes(key)));
  }
  if (schema.items) {
    const childPath = prefix ? `${prefix}[]` : "[]";
    rows.push(...flattenResponseSchemaFields(schema.items, childPath, true));
  }
  return rows;
}

export function applyResponseSchemaReviews(
  schema: ResponseSchema | undefined,
  reviews: EndpointResponseFieldReview[] | undefined,
): ResponseSchema | undefined {
  if (!schema || !reviews?.length) return schema;
  const next = structuredClone(schema);
  for (const review of reviews) {
    const node = getSchemaNode(next, review.path);
    if (!node) continue;
    if (review.description !== undefined) node.description = review.description;
    if (review.type !== undefined) node.type = review.type;
    if (review.enum_values !== undefined) node.enum_values = review.enum_values;
  }
  return next;
}

function mergeConstraint(
  constraints: WorkflowParameterConstraint[] | undefined,
  nextConstraint: WorkflowParameterConstraint,
): WorkflowParameterConstraint[] {
  const out = [...(constraints ?? []).filter((entry) => entry.kind !== nextConstraint.kind)];
  out.push(nextConstraint);
  return out;
}

export function applyParameterReviews(
  specs: WorkflowParameterSpec[],
  reviews: EndpointParameterReview[] | undefined,
): WorkflowParameterSpec[] {
  if (!reviews?.length) return specs;
  const reviewMap = new Map(reviews.map((review) => [`${review.location}:${review.name}`, review]));
  return specs.map((spec) => {
    const review = reviewMap.get(`${spec.location}:${spec.name}`);
    if (!review) return spec;
    let constraints = spec.constraints;
    if (review.format !== undefined) {
      constraints = mergeConstraint(constraints, {
        kind: "format",
        value: review.format,
      });
    }
    if (review.enum_values !== undefined && review.enum_values.length > 1) {
      constraints = mergeConstraint(constraints, {
        kind: "enum",
        description: `Reviewed allowed values for ${spec.name}.`,
      });
    }
    return {
      ...spec,
      ...(review.description !== undefined ? { description: review.description } : {}),
      ...(review.type !== undefined ? { type: review.type } : {}),
      ...(review.required !== undefined ? { required: review.required } : {}),
      ...(review.user_supplied !== undefined ? { user_supplied: review.user_supplied } : {}),
      ...(review.format !== undefined ? { format: review.format } : {}),
      ...(review.enum_values !== undefined ? { enum_values: review.enum_values } : {}),
      ...(review.derived_from !== undefined ? { derived_from: review.derived_from } : {}),
      ...(constraints?.length ? { constraints } : {}),
    };
  });
}

export function applyBindingReviews(
  bindings: OperationBinding[] | undefined,
  reviews: EndpointParameterReview[] | undefined,
): OperationBinding[] | undefined {
  if (!bindings || !reviews?.length) return bindings;
  const reviewMap = new Map(reviews.map((review) => [review.name, review]));
  return bindings.map((binding) => {
    const review = reviewMap.get(binding.key);
    if (!review) return binding;
    return {
      ...binding,
      ...(review.description !== undefined ? { description: review.description } : {}),
      ...(review.type !== undefined ? { type: review.type } : {}),
      ...(review.required !== undefined ? { required: review.required } : {}),
    };
  });
}

export function applyWorkflowSchemaReviews(
  artifact: WorkflowArtifact | null,
  reviews: EndpointReviewPayload[],
): WorkflowArtifact | null {
  if (!artifact) return artifact;
  const reviewMap = new Map(reviews.map((review) => [review.endpoint_id, review]));
  return {
    ...artifact,
    recipes: artifact.recipes.map((recipe) => {
      const review = reviewMap.get(recipe.endpoint_id);
      if (!review?.parameter_reviews?.length) return recipe;
      return {
        ...recipe,
        replay_contract: {
          ...recipe.replay_contract,
          parameter_specs: applyParameterReviews(recipe.replay_contract.parameter_specs, review.parameter_reviews),
        },
      };
    }),
  };
}

export function buildSafeParameterSpecView(spec: WorkflowParameterSpec): Record<string, unknown> {
  return {
    name: spec.name,
    location: spec.location,
    type: spec.type,
    required: spec.required,
    user_supplied: spec.user_supplied,
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.format ? { format: spec.format } : {}),
    ...(spec.enum_values?.length ? { enum_values: spec.enum_values } : {}),
    ...(spec.derived_from?.length ? { derived_from: spec.derived_from } : {}),
    ...(spec.default_value !== undefined ? { default_value: sanitizeAgentVisibleValue(spec.name, spec.default_value) } : {}),
    ...(spec.example_value !== undefined ? { example_value: sanitizeAgentVisibleValue(spec.name, spec.example_value) } : {}),
    source_hints: spec.source_hints,
  };
}
