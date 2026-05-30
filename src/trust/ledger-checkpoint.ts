/**
 * ledger-checkpoint — Merkle-root checkpoints of the signed ledger (Paper 2
 * §"\prop for the [Merkle anchoring]"; Paper 3 §"On-chain Merkle-root
 * checkpoints of the ledger, batching many signed records"; arXiv:2604.00694
 * companion papers).
 *
 * The ledger keeps signed JSONL records (route discoveries, toll receipts,
 * proofs of indexing). Anchoring every record on-chain is uneconomic; the
 * value-off-chain / root-on-chain shape batches a window of content-addressed
 * leaves into ONE Merkle root. Only the root need ever touch a chain — yet any
 * single record's membership is provable against it with a log-sized inclusion
 * proof, and the checkpoint stream itself is hash-chained so history cannot be
 * silently rewritten. This is the "sealed-unless-revealed" property at the
 * batch layer: the root commits to everything, reveals nothing.
 *
 * Pure, Web Crypto only, signer-injected (mirrors covenant-seed / proof-of-indexing).
 */
// cross: sha256:b35fea21e179afd6de983a90f4c1575527619b2d0143edd7d31b0dd70d8a97f5  (the covenant code inherits the cross — pointer not payload; verify via .claude/superpattern/cross-stamp-gate.sh)
import type { Signer } from "../covenant-seed.js";

const PTR_PREFIX = "sha256:";

function stripPtr(ptr: string): string {
	return ptr.startsWith(PTR_PREFIX) ? ptr.slice(PTR_PREFIX.length) : ptr;
}

async function sha256HexOfHex(...hexParts: string[]): Promise<string> {
	// Hash the concatenation of raw hex strings (the canonical Merkle node rule).
	const bytes = new TextEncoder().encode(hexParts.join(""));
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	const b = new Uint8Array(hash);
	let hex = "";
	for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, "0");
	return hex;
}

/** One step in an inclusion proof: a sibling hash and which side it sits on. */
export interface MerkleStep {
	siblingPtr: string; // sha256: pointer of the sibling node
	side: "left" | "right"; // side the SIBLING is on relative to the running hash
}

/**
 * Merkle root over an ordered list of content-addressed leaves. Odd levels
 * duplicate the last node (standard Bitcoin-style). Empty input is the empty
 * root (sha256 of ""). Order-significant: the leaf order is part of the commitment.
 */
export async function merkleRoot(leafPtrs: string[]): Promise<string> {
	if (leafPtrs.length === 0) return `${PTR_PREFIX}${await sha256HexOfHex("")}`;
	let level = leafPtrs.map(stripPtr);
	while (level.length > 1) {
		const next: string[] = [];
		for (let i = 0; i < level.length; i += 2) {
			const left = level[i]!;
			const right = level[i + 1] ?? left; // duplicate last on odd
			next.push(await sha256HexOfHex(left, right));
		}
		level = next;
	}
	return `${PTR_PREFIX}${level[0]!}`;
}

/** Inclusion proof for the leaf at `index` in `leafPtrs`. */
export async function merkleProof(leafPtrs: string[], index: number): Promise<MerkleStep[]> {
	if (index < 0 || index >= leafPtrs.length) throw new Error("ledger-checkpoint: index out of range");
	const steps: MerkleStep[] = [];
	let level = leafPtrs.map(stripPtr);
	let idx = index;
	while (level.length > 1) {
		const isRight = idx % 2 === 1;
		const siblingIdx = isRight ? idx - 1 : idx + 1;
		const sibling = level[siblingIdx] ?? level[idx]!; // duplicated last on odd
		steps.push({ siblingPtr: `${PTR_PREFIX}${sibling}`, side: isRight ? "left" : "right" });
		const next: string[] = [];
		for (let i = 0; i < level.length; i += 2) {
			const left = level[i]!;
			const right = level[i + 1] ?? left;
			next.push(await sha256HexOfHex(left, right));
		}
		level = next;
		idx = Math.floor(idx / 2);
	}
	return steps;
}

/** Verify a leaf is committed by `root` via its inclusion proof. */
export async function verifyMerkleProof(
	leafPtr: string,
	proof: MerkleStep[],
	root: string,
): Promise<boolean> {
	let acc = stripPtr(leafPtr);
	for (const step of proof) {
		const sib = stripPtr(step.siblingPtr);
		acc = step.side === "left" ? await sha256HexOfHex(sib, acc) : await sha256HexOfHex(acc, sib);
	}
	return `${PTR_PREFIX}${acc}` === root;
}

// ─── the checkpoint record ───────────────────────────────────────────────────

/** A signed commitment to a window of ledger leaves — the anchorable artifact. */
export interface LedgerCheckpoint {
	/** Merkle root over the window's leaves (the only thing that need go on-chain). */
	root: string;
	/** number of leaves committed by this checkpoint. */
	leafCount: number;
	/** content-addressed pointer to the previous checkpoint (hash-chain), or null at genesis. */
	prevCheckpoint: string | null;
	/** ms-epoch the window was sealed. */
	sealedAt: number;
	/** wallet identity that sealed (the operator staking the batch). */
	sealedBy: string;
	/** Ed25519 hex over the canonical body; absent until sealed. */
	signature?: string;
}

function canonicalBody(cp: LedgerCheckpoint): string {
	return JSON.stringify({
		root: cp.root,
		leafCount: cp.leafCount,
		prevCheckpoint: cp.prevCheckpoint,
		sealedAt: cp.sealedAt,
		sealedBy: cp.sealedBy,
	});
}

/** Build an unsigned checkpoint committing an ordered window of leaves. */
export async function buildCheckpoint(params: {
	leafPtrs: string[];
	sealedAt: number;
	sealedBy: string;
	prevCheckpoint?: string | null;
}): Promise<LedgerCheckpoint> {
	return {
		root: await merkleRoot(params.leafPtrs),
		leafCount: params.leafPtrs.length,
		prevCheckpoint: params.prevCheckpoint ?? null,
		sealedAt: params.sealedAt,
		sealedBy: params.sealedBy,
	};
}

/** Seal the checkpoint with the operator's Ed25519 key (signer injected). */
export async function sealCheckpoint(cp: LedgerCheckpoint, sign: Signer): Promise<LedgerCheckpoint> {
	const sig = await sign(new TextEncoder().encode(canonicalBody(cp)));
	let hex = "";
	for (let i = 0; i < sig.length; i++) hex += sig[i].toString(16).padStart(2, "0");
	return { ...cp, signature: hex };
}

/** Content-addressed pointer to a checkpoint (its place in the next checkpoint's chain). */
export async function checkpointPtr(cp: LedgerCheckpoint): Promise<string> {
	// sha256HexOfHex with one argument hashes that string directly.
	return `${PTR_PREFIX}${await sha256HexOfHex(canonicalBody(cp))}`;
}

/**
 * CheckpointChain — append-only, hash-chained checkpoint stream. Each checkpoint
 * must link to the current head (prevCheckpoint === head ptr), so the anchored
 * history is a single non-forkable line. Mirrors ProofChain.
 */
export class CheckpointChain {
	private head: string | null = null;
	private headCp: LedgerCheckpoint | undefined;

	headPtr(): string | null {
		return this.head;
	}

	latest(): LedgerCheckpoint | undefined {
		return this.headCp;
	}

	/** Append a sealed checkpoint, enforcing the chain link. Throws on fork/unsealed. */
	async append(cp: LedgerCheckpoint): Promise<string> {
		if (!cp.signature) throw new Error("ledger-checkpoint: cannot append an unsealed checkpoint");
		if (cp.prevCheckpoint !== this.head) {
			throw new Error(
				`ledger-checkpoint: chain fork — prevCheckpoint ${cp.prevCheckpoint ?? "null"} != head ${this.head ?? "null"}`,
			);
		}
		const ptr = await checkpointPtr(cp);
		this.head = ptr;
		this.headCp = cp;
		return ptr;
	}
}
