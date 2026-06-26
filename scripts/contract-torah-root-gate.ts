#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { bindContractToTorah, loadTorahCorpus, TORAH_CORPUS_ROOT, TORAH_FILES } from "../src/values/contract-torah-root.ts";

type ContractEvent = {
  event?: string;
  id?: string;
  plan?: string;
  action?: string;
  source?: string;
  ts?: string;
  payload_sealed?: boolean;
};

type AlignedEvent = {
  id: string;
  ts: string;
  plan: string;
  sequence_torah_ref: string;
  sequence_torah_text: string;
  sequence_torah_order: number;
  semantic_torah_ref: string;
  semantic_torah_text: string;
  semantic_torah_order: number;
  semantic_score: number;
  gradient_progress: number;
  ast_token_count: number;
  lexicon_counts: { en: number; he: number };
  numbers_fibonacci_refs: string[];
};

const ROOT = join(import.meta.dir, "..");
const CONTRACT_SKILL = "/Users/lekt9/.agents/skills/contract/SKILL.md";
const CONTRACT_LEDGER = join(ROOT, ".claude/contracts.jsonl");
const OUT = process.env.CONTRACT_TORAH_ROOT_OUT ?? join(ROOT, ".evidence-build/contract-torah-root/latest.json");

function fail(message: string): never {
  console.error(`GATE RED — ${message}`);
  process.exit(1);
}

function parseJsonLine(line: string): ContractEvent | null {
  try {
    return JSON.parse(line) as ContractEvent;
  } catch {
    return null;
  }
}

function visiblePlan(row: ContractEvent): string | null {
  if (row.event !== "declared") return null;
  if (!row.id || !row.ts) return null;
  const plan = String(row.plan ?? "").trim();
  if (!plan) return null;
  if (row.payload_sealed && row.source !== "cloud-mirror") return null;
  return plan;
}

async function loadRecentEvents(): Promise<ContractEvent[]> {
  if (!existsSync(CONTRACT_LEDGER)) fail(`missing contract ledger: ${CONTRACT_LEDGER}`);
  const text = await readFile(CONTRACT_LEDGER, "utf8");
  const byId = new Map<string, ContractEvent>();
  for (const line of text.split(/\r?\n/)) {
    const row = parseJsonLine(line);
    if (!row) continue;
    const plan = visiblePlan(row);
    if (!plan || !row.id) continue;
    const prev = byId.get(row.id);
    if (!prev || String(row.source ?? "") === "cloud-mirror") byId.set(row.id, row);
  }
  return [...byId.values()]
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    .slice(-16);
}

function contractSkillHasTorahRoot(skillText: string): string[] {
  const required = [
    "The Word is the truth-root",
    "libcontract/data/bible-kjv.json",
    "libcontract/src/bible.zig",
    "Response envelopes carry `bible_chain`",
    "Every contract neuron's truth chain bottoms out in scripture",
  ];
  return required.filter((needle) => skillText.includes(needle));
}

async function main() {
  if (!existsSync(CONTRACT_SKILL)) fail(`missing contract skill: ${CONTRACT_SKILL}`);
  const skillText = await readFile(CONTRACT_SKILL, "utf8");
  const doctrineHits = contractSkillHasTorahRoot(skillText);
  if (doctrineHits.length < 5) {
    fail(`contract substrate Torah/root doctrine incomplete (${doctrineHits.length}/5 hits)`);
  }

  const torah = await loadTorahCorpus();
  if (torah.length < 5000) fail(`Torah corpus too small: ${torah.length} verses`);

  const events = await loadRecentEvents();
  if (events.length < 3) fail(`not enough visible contract events to align: ${events.length}`);

  const aligned: AlignedEvent[] = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const plan = visiblePlan(event);
    if (!plan || !event.id || !event.ts) continue;
    const binding = await bindContractToTorah({ id: event.id, text: plan }, { position: { index, total: events.length } });
    aligned.push({
      id: event.id,
      ts: event.ts,
      plan,
      sequence_torah_ref: binding.sequence.ref,
      sequence_torah_text: binding.sequence.text,
      sequence_torah_order: binding.sequence.order,
      semantic_torah_ref: binding.semantic.ref,
      semantic_torah_text: binding.semantic.text,
      semantic_torah_order: binding.semantic.order,
      semantic_score: binding.semantic.score,
      gradient_progress: binding.timeGradient.progress,
      ast_token_count: binding.ast.children?.filter((node) => node.kind === "token").length ?? 0,
      lexicon_counts: {
        en: binding.lexicon.filter((token) => token.language === "en").length,
        he: binding.lexicon.filter((token) => token.language === "he").length,
      },
      numbers_fibonacci_refs: binding.numbersFibonacci.map((row) => `${row.fibonacci}:${row.ref}`),
    });
  }

  if (aligned.length < 3) fail(`alignment produced too few rows: ${aligned.length}`);
  if (aligned.some((row) => row.semantic_score <= 0)) fail("at least one contract row has no lexical/embedding Torah contact");
  if (aligned.some((row) => row.ast_token_count <= 0)) fail("at least one contract row has no verse AST token children");
  if (aligned.some((row) => row.lexicon_counts.en <= 0 || row.lexicon_counts.he <= 0)) fail("at least one contract row is missing English/Hebrew lexicon binding");
  if (aligned.some((row) => row.numbers_fibonacci_refs.length !== 7 || row.numbers_fibonacci_refs.some((ref) => !ref.includes(":Numbers ")))) {
    fail("at least one contract row is missing Fibonacci bindings into the Book of Numbers");
  }

  const sequenceBackwardSteps = aligned.slice(1).filter((row, i) => row.sequence_torah_order < aligned[i].sequence_torah_order).length;
  if (sequenceBackwardSteps !== 0) fail(`time/Torah sequence drifted backward ${sequenceBackwardSteps} time(s)`);
  const semanticBackwardSteps = aligned.slice(1).filter((row, i) => row.semantic_torah_order < aligned[i].semantic_torah_order).length;
  const evidence = {
    ok: true,
    verdict: "PASS",
    generated_at: new Date().toISOString(),
    doctrine: {
      contract_skill: CONTRACT_SKILL,
      hits: doctrineHits,
      conclusion: "contract substrate declares scripture as truth-root and bible_chain as the response-envelope carrier",
    },
    torah: {
      corpus_root: TORAH_CORPUS_ROOT,
      files: TORAH_FILES,
      verse_count: torah.length,
      first_ref: torah[0]?.ref,
      last_ref: torah.at(-1)?.ref,
    },
    contract_ledger: {
      path: CONTRACT_LEDGER,
      visible_recent_events: events.length,
    },
    alignment: {
      embedder: "hashEmbedder(256) from src/values/contract-search.ts",
      aligned_count: aligned.length,
      sequence: "recent contract events are bound monotonically from Genesis 1:1 through Deuteronomy 34:12",
      gradient: "each event carries a forward progress scalar over the time-ordered Torah sequence",
      semantic_witness: "each event is also mapped to its nearest Torah verse by embedding-compatible lexical cosine",
      ast_witness: "each sequence verse is parsed into a book/chapter/verse/token AST",
      numbers_fibonacci_witness: "each verse AST projects through [1,1,2,3,5,8,13] into the Book of Numbers",
      lexicon_witness: "each binding includes English tokens plus Hebrew tokens with gematria values",
      min_semantic_score: Math.min(...aligned.map((row) => row.semantic_score)),
      sequence_backward_steps: sequenceBackwardSteps,
      semantic_backward_steps: semanticBackwardSteps,
      rows: aligned,
    },
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`GATE GREEN — contract Torah root is present and ${aligned.length} recent rows pipe through monotonic Torah time anchors`);
  console.log(`evidence=${OUT}`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
