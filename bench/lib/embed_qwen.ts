/**
 * Shared embedding substrate — Qwen3-Embedding-0.6B (TypeScript side).
 *
 * Same HF model as bench/lib/embed_qwen.py, run through transformers.js ONNX so
 * the vectors line up across languages (see parity_test.py for the gate).
 *
 * transformers.js needs an ONNX export; the official Qwen repo ships only
 * safetensors, so we use the canonical onnx-community port (same weights,
 * exported to ONNX). dtype fp32 -> onnx/model.onnx, full precision, to match the
 * Python sentence-transformers fp32 reference for parity.
 *
 * Qwen3-Embedding is last-token pooled. transformers.js >=3 exposes
 * `pooling: 'last_token'` on the feature-extraction pipeline; we pair it with
 * `normalize: true` to match the Python L2-normalized output.
 *
 * Public API:
 *   embed(texts: string[]): Promise<number[][]>   // L2-normalized vectors
 *   rankPassages(doc, query, window): Promise<string>
 *
 * CLI:
 *   node --experimental-strip-types embed_qwen.ts "some text"
 *   node --experimental-strip-types embed_qwen.ts --json "a" "b" "c"
 */

import {
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

export const MODEL_ID = "onnx-community/Qwen3-Embedding-0.6B-ONNX";

const QUERY_INSTRUCT =
  "Instruct: Given a web search query, retrieve relevant passages that " +
  "answer the query\nQuery: ";

let _pipe: Promise<FeatureExtractionPipeline> | null = null;

function getPipe(): Promise<FeatureExtractionPipeline> {
  if (_pipe === null) {
    // fp32 keeps the ONNX weights full-precision for the best parity with the
    // torch reference. Apple has no CoreML EP here, so this runs on CPU.
    _pipe = pipeline("feature-extraction", MODEL_ID, {
      dtype: "fp32",
    }) as Promise<FeatureExtractionPipeline>;
  }
  return _pipe;
}

function l2normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return v;
  return v.map((x) => x / n);
}

/** Embed texts -> L2-normalized float vectors (one per input). */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const pipe = await getPipe();
  const out: number[][] = [];
  // one at a time so last-token pooling is unaffected by right-padding
  for (const t of texts) {
    const tensor = await pipe(t, { pooling: "last_token", normalize: true });
    const arr = Array.from(tensor.data as Float32Array).map(Number);
    out.push(l2normalize(arr));
  }
  return out;
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// --- Passage ranking (mirror of the Python helper) -----------------------

function chunk(doc: string, window: number, stride?: number): string[] {
  const words = doc.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const st = stride ?? Math.max(1, Math.floor(window / 2));
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += st) {
    chunks.push(words.slice(i, i + window).join(" "));
    if (i + window >= words.length) break;
  }
  return chunks;
}

export async function rankPassages(
  doc: string,
  query: string,
  window = 60,
): Promise<string> {
  const chunks = chunk(doc, window);
  if (chunks.length === 0) return "";
  if (chunks.length === 1) return chunks[0];
  const [qv] = await embed([QUERY_INSTRUCT + query]);
  const cvs = await embed(chunks);
  let bestI = 0;
  let bestS = -2;
  for (let i = 0; i < cvs.length; i++) {
    const s = cosine(qv, cvs[i]);
    if (s > bestS) {
      bestS = s;
      bestI = i;
    }
  }
  return chunks[bestI];
}

// --- CLI ------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  let args = argv.slice(2);
  let asJson = false;
  if (args[0] === "--json") {
    asJson = true;
    args = args.slice(1);
  }
  if (args.length === 0) {
    console.log('usage: node embed_qwen.ts [--json] "text" ["text2" ...]');
    return 2;
  }
  const vecs = await embed(args);
  if (asJson) {
    console.log(JSON.stringify(vecs));
    return 0;
  }
  console.log(`backend: transformers.js (onnx) ${MODEL_ID}`);
  for (let i = 0; i < args.length; i++) {
    const v = vecs[i];
    const head = v
      .slice(0, 5)
      .map((x) => x.toFixed(6))
      .join(", ");
    const snip = args[i].length <= 50 ? args[i] : args[i].slice(0, 47) + "...";
    console.log(`  "${snip}"  dims=${v.length}  first5=[${head}]`);
  }
  return 0;
}

// run when invoked directly
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("embed_qwen.ts");
if (isMain) {
  main(process.argv).then((code) => process.exit(code));
}
