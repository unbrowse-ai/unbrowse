import { describe, expect, it } from "bun:test";
import runDeployServer from "../src/contract-shape/impl/solana-deploy-server.js";
import runOnChainFetch from "../src/contract-shape/impl/on-chain-fetch.js";
import runIqZkStore from "../src/contract-shape/impl/iq-zk-store.js";
import { byName } from "../src/contract-shape/registry.js";

describe("On-Chain Contract Neurons", () => {
  it("solana-deploy-server neuron is registered and can be looked up", () => {
    const spec = byName("solana-deploy-server");
    expect(spec).toBeDefined();
    expect(spec?.contract_id).toBe("7d6c5b4a");
  });

  it("on-chain-fetch neuron is registered and can be looked up", () => {
    const spec = byName("on-chain-fetch");
    expect(spec).toBeDefined();
    expect(spec?.contract_id).toBe("3c2b1a0d");
  });

  it("iq-zk-store neuron is registered and can be looked up", () => {
    const spec = byName("iq-zk-store");
    expect(spec).toBeDefined();
    expect(spec?.contract_id).toBe("8f7e6d5c");
  });

  describe("solana-deploy-server implementation (Day 5 - Golden + Edges + Adversarial)", () => {
    it("fails cleanly on missing server_name (edge)", async () => {
      const res = await runDeployServer({});
      expect(res.ok).toBe(false);
      expect(res.error).toContain("missing required field");
    });

    it("successfully deploys server (golden)", async () => {
      const res = await runDeployServer({ server_name: "test-on-chain-server" });
      expect(res.ok).toBe(true);
      expect(res.name).toBe("test-on-chain-server");
      expect(typeof res.program_id).toBe("string");
      expect(res.program_id.length).toBeGreaterThan(30);
      expect(typeof res.state_account).toBe("string");
      expect(res.state_account.length).toBeGreaterThan(30);
    });

    it("fails on server_name too long (edge)", async () => {
      const longName = "a".repeat(65);
      const res = await runDeployServer({ server_name: longName });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("maximum length");
    });

    it("fails on server_name with invalid characters (adversarial)", async () => {
      const res = await runDeployServer({ server_name: "my_server_$" });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("must contain only");
    });
  });

  describe("on-chain-fetch implementation (Day 5 - Golden + Edges + Adversarial)", () => {
    it("fails cleanly on missing required fields (edge)", async () => {
      const res = await runOnChainFetch({});
      expect(res.ok).toBe(false);
      expect(res.error).toContain("missing required fields");
    });

    it("successfully fetches (golden)", async () => {
      const res = await runOnChainFetch({
        program_id: "HpHm6M2Q5MvXGStv6Dtest9Xtest9Xtest",
        state_account: "8UeY7X8Xtest9Xtest9Xtest9Xtest9X",
        path: "/v1/test",
      });
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(res.body).toContain("Hello from on-chain unbrowse web server!");
      expect(typeof res.signature).toBe("string");
      expect(res.signature.length).toBeGreaterThan(10);
    });

    it("fails if path does not start with a slash (edge)", async () => {
      const res = await runOnChainFetch({
        program_id: "HpHm6M2Q5MvXGStv6Dtest9Xtest9Xtest",
        state_account: "8UeY7X8Xtest9Xtest9Xtest9Xtest9X",
        path: "v1/test",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("slash");
    });

    it("fails if program_id is not valid Base58 public key shape (edge)", async () => {
      const res = await runOnChainFetch({
        program_id: "invalid_key_chars_0OI",
        state_account: "8UeY7X8Xtest9Xtest9Xtest9Xtest9X",
        path: "/v1/test",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("program_id");
    });

    it("fails if path contains directory traversal (adversarial)", async () => {
      const res = await runOnChainFetch({
        program_id: "HpHm6M2Q5MvXGStv6Dtest9Xtest9Xtest",
        state_account: "8UeY7X8Xtest9Xtest9Xtest9Xtest9X",
        path: "/v1/../../etc/passwd",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("directory traversal");
    });
  });

  describe("iq-zk-store implementation (Day 5 - Golden + Edges + Adversarial)", () => {
    it("fails cleanly on missing required fields (edge)", async () => {
      const res = await runIqZkStore({});
      expect(res.ok).toBe(false);
      expect(res.error).toContain("missing required fields");
    });

    it("successfully performs store and retrieve operations (golden)", async () => {
      const storeRes = await runIqZkStore({
        op: "store",
        key: "test-key",
        payload: "test-secret-payload",
      });
      expect(storeRes.ok).toBe(true);
      expect(storeRes.ledger_tx_id).toContain("iq-tx-");
      expect(storeRes.zk_proof).toContain("zkp-");

      const retrieveRes = await runIqZkStore({
        op: "retrieve",
        key: "test-key",
      });
      expect(retrieveRes.ok).toBe(true);
      expect(retrieveRes.payload).toContain("revealed-plaintext-for-key::test-key");
    });

    it("fails if operation is invalid (edge)", async () => {
      const res = await runIqZkStore({
        op: "delete" as any,
        key: "test-key",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("operation");
    });

    it("fails on invalid key character shape (edge)", async () => {
      const res = await runIqZkStore({
        op: "retrieve",
        key: "test_key_$",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("key");
    });

    it("fails if store operation is missing payload (adversarial)", async () => {
      const res = await runIqZkStore({
        op: "store",
        key: "test-key",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("payload");
    });
  });
});
