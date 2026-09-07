import { describe, expect, it } from "bun:test";
import {
	merkleRoot,
	merkleProof,
	verifyMerkleProof,
	buildCheckpoint,
	sealCheckpoint,
	checkpointPtr,
	CheckpointChain,
} from "../src/trust/ledger-checkpoint.js";

async function ed25519Signer() {
	const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const sign = async (m: Uint8Array): Promise<Uint8Array> =>
		new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, m));
	return { sign, publicKey: kp.publicKey };
}

const leaf = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;

describe("merkle root", () => {
	it("is deterministic and order-significant", async () => {
		const a = await merkleRoot([leaf(1), leaf(2), leaf(3)]);
		expect(await merkleRoot([leaf(1), leaf(2), leaf(3)])).toBe(a);
		expect(await merkleRoot([leaf(3), leaf(2), leaf(1)])).not.toBe(a);
		expect(a).toStartWith("sha256:");
	});

	it("single leaf and odd counts both produce a root", async () => {
		expect(await merkleRoot([leaf(1)])).toStartWith("sha256:");
		expect(await merkleRoot([leaf(1), leaf(2), leaf(3), leaf(4), leaf(5)])).toStartWith("sha256:");
		expect(await merkleRoot([])).toStartWith("sha256:"); // empty root
	});
});

describe("inclusion proof", () => {
	it("verifies every leaf in a window against the root", async () => {
		const leaves = [leaf(10), leaf(11), leaf(12), leaf(13), leaf(14)]; // odd count
		const root = await merkleRoot(leaves);
		for (let i = 0; i < leaves.length; i++) {
			const proof = await merkleProof(leaves, i);
			expect(await verifyMerkleProof(leaves[i]!, proof, root)).toBe(true);
		}
	});

	it("rejects a forged leaf and a wrong root", async () => {
		const leaves = [leaf(1), leaf(2), leaf(3), leaf(4)];
		const root = await merkleRoot(leaves);
		const proof = await merkleProof(leaves, 2);
		expect(await verifyMerkleProof(leaf(999), proof, root)).toBe(false); // not in the tree
		expect(await verifyMerkleProof(leaves[2]!, proof, await merkleRoot([leaf(1)]))).toBe(false); // wrong root
	});

	it("throws on out-of-range index", async () => {
		await expect(merkleProof([leaf(1)], 5)).rejects.toThrow(/out of range/);
	});
});

describe("checkpoint build + seal + chain", () => {
	it("commits a window, seals it, and content-addresses independent of signature", async () => {
		const { sign } = await ed25519Signer();
		const leaves = [leaf(1), leaf(2), leaf(3)];
		const cp = await buildCheckpoint({ leafPtrs: leaves, sealedAt: 100, sealedBy: "op:1", prevCheckpoint: null });
		expect(cp.leafCount).toBe(3);
		expect(cp.root).toBe(await merkleRoot(leaves));
		expect(cp.signature).toBeUndefined();

		const sealed = await sealCheckpoint(cp, sign);
		expect(sealed.signature).toBeString();
		expect(await checkpointPtr(cp)).toBe(await checkpointPtr(sealed)); // signature not in the address
	});

	it("hash-chains checkpoints and rejects a fork", async () => {
		const { sign } = await ed25519Signer();
		const chain = new CheckpointChain();
		expect(chain.headPtr()).toBeNull();

		const cp1 = await sealCheckpoint(
			await buildCheckpoint({ leafPtrs: [leaf(1)], sealedAt: 1, sealedBy: "op", prevCheckpoint: null }),
			sign,
		);
		const ptr1 = await chain.append(cp1);
		expect(chain.headPtr()).toBe(ptr1);

		const cp2 = await sealCheckpoint(
			await buildCheckpoint({ leafPtrs: [leaf(2), leaf(3)], sealedAt: 2, sealedBy: "op", prevCheckpoint: ptr1 }),
			sign,
		);
		await chain.append(cp2);
		expect(chain.latest()?.leafCount).toBe(2);

		const fork = await sealCheckpoint(
			await buildCheckpoint({ leafPtrs: [leaf(9)], sealedAt: 3, sealedBy: "op", prevCheckpoint: ptr1 }),
			sign,
		);
		await expect(chain.append(fork)).rejects.toThrow(/chain fork/);
	});

	it("refuses an unsealed checkpoint", async () => {
		const chain = new CheckpointChain();
		const cp = await buildCheckpoint({ leafPtrs: [leaf(1)], sealedAt: 1, sealedBy: "op" });
		await expect(chain.append(cp)).rejects.toThrow(/unsealed/);
	});
});
