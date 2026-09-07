import { describe, expect, it } from "bun:test";
import {
  contractRowToNeuron,
  fireContractNeuron,
  graphEdgeToSynapse,
  reinforceSynapse,
  validateNeuralGraphWrite,
} from "../src/services/neural-contract.js";

describe("contract DAG neural substrate", () => {
  it("projects a contract row into a thresholded neuron", () => {
    const row = {
      event: "declared",
      id: "root-sequence",
      ts: "2026-05-25T00:00:00.000Z",
      action: "sequence",
    } as const;

    const actual = contractRowToNeuron(row, "pending");
    const expected = {
      id: "root-sequence",
      kind: "sequence",
      threshold: 1,
      potential: 0,
      refractory_until_wave: 0,
      status: "pending",
    };

    expect(actual).toEqual(expected);
  });

  it("fires only when weighted synapses cross threshold", () => {
    const neuron = {
      id: "target",
      kind: "quorum",
      threshold: 2,
      potential: 0,
      refractory_until_wave: 0,
      status: "active",
    } as const;

    const actual = fireContractNeuron({
      neuron,
      incoming: [
        { from: "a", to: "target", kind: "contract-ref", weight: 1 },
        { from: "b", to: "target", kind: "contract-ref", weight: 1 },
      ],
      activeSourceIds: ["a", "b"],
      wave: 1,
    });
    const expected = {
      fired: true,
      potential: 2,
      threshold: 2,
      inhibited: false,
      refractory: false,
    };

    expect(actual).toEqual(expected);
  });

  it("blocks firing while refractory or inhibited", () => {
    const neuron = {
      id: "target",
      kind: "cell",
      threshold: 1,
      potential: 0,
      refractory_until_wave: 2,
      status: "active",
    } as const;

    const actual = fireContractNeuron({
      neuron,
      incoming: [
        { from: "a", to: "target", kind: "contract-ref", weight: 1 },
        { from: "stop", to: "target", kind: "inhibits", weight: 1 },
      ],
      activeSourceIds: ["a", "stop"],
      wave: 2,
    });
    const expected = {
      fired: false,
      potential: 0,
      threshold: 1,
      inhibited: true,
      refractory: true,
    };

    expect(actual).toEqual(expected);
  });

  it("reinforces co-fired synapses and penalizes misses", () => {
    const synapse = { from: "a", to: "b", kind: "requires", weight: 0.5 } as const;

    const actual = [
      reinforceSynapse(synapse, "cofire").weight,
      reinforceSynapse(synapse, "miss").weight,
    ];
    const expected = [0.55, 0.42];

    expect(actual).toEqual(expected);
  });

  it("rejects graph writes that do not use the typed interface", () => {
    const actual = validateNeuralGraphWrite(
      "example.com",
      { endpoint_id: "../raw" },
      [{ to: "detail", binding: "item_id" }],
    );
    const expected = {
      ok: false,
      errors: ["node.endpoint_id must be a typed id"],
    };

    expect(actual).toEqual(expected);
  });

  it("maps graph edges to typed synapses", () => {
    const actual = graphEdgeToSynapse("search", { to: "detail", binding: "contract:abc12345" });
    const expected = {
      from: "search",
      to: "detail",
      kind: "contract-ref",
      weight: 1,
    };

    expect(actual).toEqual(expected);
  });
});
