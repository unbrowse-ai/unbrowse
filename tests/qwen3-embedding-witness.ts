// Witness: Qwen3-Embedding-4B served by the CONTRACT-NATIVE llama.cpp bind (aiko-ebllm) is the
// canonical local embedder for the emergent caching layer — on-device, no ollama, no cloud key.
// Proves (1) the vector is EXACTLY 1536-dim (MRL-reduced from the model's native 2560 → fits the
// 1536-locked emergent RAG store), and (2) LEARNED SEMANTICS: a query that shares NO tokens with
// the target ("a feline rested on a rug" vs "the cat sat on the mat") still ranks the target #1.
// This is a LIVE scaffold (needs the llama.cpp embedding server up), not a standing build gate:
// when the server is unreachable it SKIPs honestly (exit 0, no fabricated green); when up it asserts.
import { llamaCppEmbedder, memCosineStore, indexContractRows, searchContracts } from "../src/values/contract-search.js";

const embed = llamaCppEmbedder(); // Qwen3-Embedding-4B @ 1536 via the contract-native llama.cpp :8090

// Probe reachability first — a down server is a SKIP, never a fake fail or fake pass.
let probe: number[];
try {
  probe = await embed.embed("dimension probe");
} catch (e) {
  console.log(`QWEN3_EMBEDDING_WITNESS_SKIP — contract-native llama.cpp embed server unreachable: ${(e as Error).message}`);
  console.log("  start it: cd ~/Projects/unbrowse-ecosystem/aiko-ebllm && llama-server -m models/Qwen3-Embedding-4B-Q4_K_M.gguf --embeddings --port 8090 -c 2048 --no-webui");
  process.exit(0);
}

const store = memCosineStore();
const CAT = "cat-sat";
const PHYS = "qcd-lattice";
await indexContractRows(
  [
    { id: CAT, text: "the cat sat on the mat" },
    { id: PHYS, text: "quantum chromodynamics on a lattice gauge" },
  ],
  embed,
  store,
);

const dim = probe.length;
const ranked = await searchContracts("a feline rested on a rug", embed, store, 2);
const top = ranked[0]?.id;

const dimOk = dim === 1536; // MRL-reduced — the exact emergent-locked dim
const semanticOk = top === CAT;

console.log(`qwen3-embedding-4b: dim=${dim} (expect 1536: ${dimOk})`);
console.log(`qwen3-embedding-4b: top match for "a feline rested on a rug" = ${top} (expect ${CAT}: ${semanticOk})`);
console.log(`ranked: ${JSON.stringify(ranked)}`);

if (dimOk && semanticOk) {
  console.log("QWEN3_EMBEDDING_WITNESS_OK — contract-native llama.cpp embedder gives learned semantics at 1536-dim (emergent-RAG-native)");
  process.exit(0);
}
console.error("QWEN3_EMBEDDING_WITNESS_FAIL");
process.exit(1);
