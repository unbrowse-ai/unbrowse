import { buildSkillOperationGraph } from "../graph/index.js";
import type { SkillManifest } from "../types/index.js";

function operationTitle(actionKind: string, resourceKind: string): string {
  return `${actionKind.replace(/_/g, " ")} ${resourceKind.replace(/_/g, " ")}`.trim();
}

export function buildEndpointReviewContext(skill: SkillManifest, endpointId: string): Record<string, unknown> | null {
  const graph = skill.operation_graph ?? buildSkillOperationGraph(skill.endpoints);
  const operation = graph.operations.find((candidate) => candidate.endpoint_id === endpointId);
  const endpoint = skill.endpoints.find((candidate) => candidate.endpoint_id === endpointId);
  if (!operation || !endpoint) return null;

  const dependencies = graph.edges
    .filter((edge) => edge.to_operation_id === operation.operation_id)
    .map((edge) => {
      const source = graph.operations.find((candidate) => candidate.operation_id === edge.from_operation_id);
      if (!source) return null;
      return {
        endpoint_id: source.endpoint_id,
        operation_id: source.operation_id,
        title: operationTitle(source.action_kind, source.resource_kind),
        binding_key: edge.binding_key,
        kind: edge.kind,
        confidence: edge.confidence,
        description_out: source.description_out,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => !!entry);

  const unlocks = graph.edges
    .filter((edge) => edge.from_operation_id === operation.operation_id)
    .map((edge) => {
      const target = graph.operations.find((candidate) => candidate.operation_id === edge.to_operation_id);
      if (!target) return null;
      return {
        endpoint_id: target.endpoint_id,
        operation_id: target.operation_id,
        title: operationTitle(target.action_kind, target.resource_kind),
        binding_key: edge.binding_key,
        kind: edge.kind,
        confidence: edge.confidence,
        description_out: target.description_out,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => !!entry);

  const triggerSiblings = skill.endpoints
    .filter((candidate) => candidate.endpoint_id !== endpointId && candidate.trigger_url && candidate.trigger_url === endpoint.trigger_url)
    .slice(0, 5)
    .map((candidate) => ({
      endpoint_id: candidate.endpoint_id,
      method: candidate.method,
      description: candidate.description ?? candidate.semantic?.description_out ?? "",
      dom_extraction: !!candidate.dom_extraction,
      trigger_url: candidate.trigger_url,
    }));

  return {
    operation_id: operation.operation_id,
    title: operationTitle(operation.action_kind, operation.resource_kind),
    action_kind: operation.action_kind,
    resource_kind: operation.resource_kind,
    description_in: operation.description_in,
    response_summary: operation.response_summary,
    requires: operation.requires ?? [],
    provides: operation.provides ?? [],
    negative_tags: operation.negative_tags ?? [],
    provenance: endpoint.dom_extraction
      ? "dom_extraction"
      : endpoint.method === "WS"
        ? "websocket"
        : "http_replay",
    trigger_url: endpoint.trigger_url ?? null,
    verification_status: endpoint.verification_status,
    reliability_score: endpoint.reliability_score,
    dependencies,
    unlocks,
    trigger_siblings: triggerSiblings,
  };
}
