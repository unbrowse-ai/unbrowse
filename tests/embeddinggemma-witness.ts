// Witness: embeddinggemma-300m is the canonical /contract-native local embedder.
// Proves LEARNED SEMANTICS (the reason to use it over the hash embedder): a query
// that shares NO tokens with the target ("a feline rested on a rug" vs "the cat sat
// on the mat") still ranks the target #1, and the vector is 768-dim. Exit 0 = green.
import { ollamaEmbedder, memCosineStore, indexContractRows, searchContracts } from "../src/values/contract-search.js";

const embed = ollamaEmbedder(); // default model is now "embeddinggemma"
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

// dim check
const v = await embed.embed("dimension probe");
const dim = v.length;

// learned-semantics check: NO shared tokens with the cat sentence
const ranked = await searchContracts("a feline rested on a rug", embed, store, 2);
const top = ranked[0]?.id;

const dimOk = dim === 768;
const semanticOk = top === CAT;

console.log(`embeddinggemma: dim=${dim} (expect 768: ${dimOk})`);
console.log(`embeddinggemma: top match for "a feline rested on a rug" = ${top} (expect ${CAT}: ${semanticOk})`);
console.log(`ranked: ${JSON.stringify(ranked)}`);

if (dimOk && semanticOk) {
  console.log("EMBEDDINGGEMMA_WITNESS_OK — canonical local embedder gives learned semantics at 768-dim");
  process.exit(0);
}
console.error("EMBEDDINGGEMMA_WITNESS_FAIL");
process.exit(1);
