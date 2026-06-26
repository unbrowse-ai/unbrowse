/**
 * contract-torah-root — the native Torah binding for every persisted contract.
 *
 * The external contract binary already declares scripture as truth-root. This module makes that
 * invariant reachable inside Unbrowse's own value layer: every ContractEverything row can be bound
 * to (1) a deterministic Torah sequence anchor and (2) a semantic Torah witness. The native Zig
 * bible organ is used when available; the local Torah corpus + hashEmbedder fallback keeps the gate
 * runnable offline and fail-closed.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { bibleAnchorNative } from "./contract-native.js";
import { cosine, hashEmbedder } from "./contract-search.js";

export const TORAH_CORPUS_ROOT = "/Users/lekt9/.claude/bible";
export const TORAH_FILES = [
  "01_Genesis.txt",
  "02_Exodus.txt",
  "03_Leviticus.txt",
  "04_Numbers.txt",
  "05_Deuteronomy.txt",
] as const;

const TORAH_HEBREW_FILES = [
  "01_Genesis.heb.txt",
  "02_Exodus.heb.txt",
  "03_Leviticus.heb.txt",
  "04_Numbers.heb.txt",
  "05_Deuteronomy.heb.txt",
] as const;

const NUMBERS_FILE = "04_Numbers.txt";
const NUMBERS_HEBREW_FILE = "04_Numbers.heb.txt";

export interface TorahVerse {
  ref: string;
  text: string;
  order: number;
}

export interface LexiconToken {
  language: "en" | "he";
  token: string;
  normalized: string;
  ordinal: number;
  length: number;
  gematria?: number;
}

export interface VerseAstNode {
  kind: "verse" | "book" | "chapter" | "token";
  value: string;
  children?: VerseAstNode[];
}

export interface NumbersFibonacciBinding {
  ref: string;
  text: string;
  hebrewText: string | null;
  fibonacci: number;
  depth: number;
}

export interface TorahTimeGradient {
  position: number;
  total: number;
  progress: number;
  direction: "forward";
  previousRef: string | null;
  currentRef: string;
  nextRef: string | null;
}

export interface ContractTorahBinding {
  root: "torah";
  corpusRoot: string;
  sequence: TorahVerse;
  semantic: TorahVerse & { score: number };
  timeGradient: TorahTimeGradient;
  ast: VerseAstNode;
  lexicon: LexiconToken[];
  numbersFibonacci: NumbersFibonacciBinding[];
  nativeBibleAnchorIndex: number | null;
}

let cachedTorah: TorahVerse[] | null = null;
let cachedHebrewByRef: Map<string, string> | null = null;
let cachedNumbers: TorahVerse[] | null = null;
let cachedNumbersHebrewByRef: Map<string, string> | null = null;

export async function loadTorahCorpus(root = TORAH_CORPUS_ROOT): Promise<TorahVerse[]> {
  if (cachedTorah && root === TORAH_CORPUS_ROOT) return cachedTorah;
  const verses: TorahVerse[] = [];
  for (const file of TORAH_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) throw new Error(`missing Torah corpus file: ${path}`);
    const text = await readFile(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [ref, verseText] = trimmed.split("\t", 2);
      if (ref && verseText) verses.push({ ref, text: verseText, order: verses.length });
    }
  }
  if (verses.length < 5000) throw new Error(`Torah corpus too small: ${verses.length} verses`);
  if (root === TORAH_CORPUS_ROOT) cachedTorah = verses;
  return verses;
}

async function loadRefTextMap(files: readonly string[], root = TORAH_CORPUS_ROOT): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const file of files) {
    const path = join(root, file);
    if (!existsSync(path)) throw new Error(`missing Bible corpus file: ${path}`);
    const text = await readFile(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [ref, verseText] = trimmed.split("\t", 2);
      if (ref && verseText) out.set(ref, verseText);
    }
  }
  return out;
}

async function loadTorahHebrewByRef(root = TORAH_CORPUS_ROOT): Promise<Map<string, string>> {
  if (cachedHebrewByRef && root === TORAH_CORPUS_ROOT) return cachedHebrewByRef;
  const map = await loadRefTextMap(TORAH_HEBREW_FILES, root);
  if (root === TORAH_CORPUS_ROOT) cachedHebrewByRef = map;
  return map;
}

async function loadNumbersCorpus(root = TORAH_CORPUS_ROOT): Promise<TorahVerse[]> {
  if (cachedNumbers && root === TORAH_CORPUS_ROOT) return cachedNumbers;
  const path = join(root, NUMBERS_FILE);
  if (!existsSync(path)) throw new Error(`missing Numbers corpus file: ${path}`);
  const verses: TorahVerse[] = [];
  const text = await readFile(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [ref, verseText] = trimmed.split("\t", 2);
    if (ref && verseText) verses.push({ ref, text: verseText, order: verses.length });
  }
  if (verses.length < 1000) throw new Error(`Numbers corpus too small: ${verses.length} verses`);
  if (root === TORAH_CORPUS_ROOT) cachedNumbers = verses;
  return verses;
}

async function loadNumbersHebrewByRef(root = TORAH_CORPUS_ROOT): Promise<Map<string, string>> {
  if (cachedNumbersHebrewByRef && root === TORAH_CORPUS_ROOT) return cachedNumbersHebrewByRef;
  const map = await loadRefTextMap([NUMBERS_HEBREW_FILE], root);
  if (root === TORAH_CORPUS_ROOT) cachedNumbersHebrewByRef = map;
  return map;
}

function stableIndex(seed: string, modulo: number): number {
  const h = createHash("sha256").update(seed).digest();
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + h[i];
  return n % modulo;
}

function sequenceIndex(seed: string, total: number, position?: { index: number; total: number }): number {
  if (position && position.total > 1) {
    const i = Math.max(0, Math.min(position.index, position.total - 1));
    return i === position.total - 1 ? total - 1 : Math.floor((i / (position.total - 1)) * (total - 1));
  }
  return stableIndex(seed, total);
}

function parseRef(ref: string): { book: string; chapter: string; verse: string } {
  const match = ref.match(/^(.+) (\d+):(\d+)$/);
  if (!match) return { book: ref, chapter: "", verse: "" };
  return { book: match[1], chapter: match[2], verse: match[3] };
}

function englishTokens(text: string): LexiconToken[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 16)
    .map((token, ordinal) => ({ language: "en", token, normalized: token, ordinal, length: token.length }));
}

function hebrewGematria(token: string): number {
  const values: Record<number, number> = {
    0x05d0: 1, 0x05d1: 2, 0x05d2: 3, 0x05d3: 4, 0x05d4: 5, 0x05d5: 6, 0x05d6: 7, 0x05d7: 8, 0x05d8: 9,
    0x05d9: 10, 0x05db: 20, 0x05da: 20, 0x05dc: 30, 0x05de: 40, 0x05dd: 40, 0x05e0: 50, 0x05df: 50,
    0x05e1: 60, 0x05e2: 70, 0x05e4: 80, 0x05e3: 80, 0x05e6: 90, 0x05e5: 90, 0x05e7: 100, 0x05e8: 200, 0x05e9: 300, 0x05ea: 400,
  };
  let sum = 0;
  for (const ch of token) sum += values[ch.codePointAt(0) ?? 0] ?? 0;
  return sum;
}

function hebrewTokens(text: string | null): LexiconToken[] {
  if (!text) return [];
  return text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 16)
    .map((token, ordinal) => ({
      language: "he",
      token,
      normalized: token,
      ordinal,
      length: [...token].length,
      gematria: hebrewGematria(token),
    }));
}

function verseAst(verse: TorahVerse, lexicon: LexiconToken[]): VerseAstNode {
  const parsed = parseRef(verse.ref);
  return {
    kind: "verse",
    value: verse.ref,
    children: [
      { kind: "book", value: parsed.book },
      { kind: "chapter", value: parsed.chapter, children: [{ kind: "verse", value: parsed.verse }] },
      ...lexicon.map((token) => ({ kind: "token" as const, value: `${token.language}:${token.normalized}` })),
    ],
  };
}

function fibonacci(n: number): number {
  let a = 1, b = 1;
  for (let i = 0; i < n; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return a;
}

function timeGradient(torah: TorahVerse[], sequence: TorahVerse, position?: { index: number; total: number }): TorahTimeGradient {
  const total = position?.total && position.total > 0 ? position.total : torah.length;
  const index = position ? Math.max(0, Math.min(position.index, total - 1)) : sequence.order;
  return {
    position: index,
    total,
    progress: Number((total <= 1 ? 1 : index / (total - 1)).toFixed(6)),
    direction: "forward",
    previousRef: torah[sequence.order - 1]?.ref ?? null,
    currentRef: sequence.ref,
    nextRef: torah[sequence.order + 1]?.ref ?? null,
  };
}

function numbersFibonacciBindings(
  seed: string,
  sequence: TorahVerse,
  lexicon: LexiconToken[],
  numbers: TorahVerse[],
  numbersHebrewByRef: Map<string, string>,
): NumbersFibonacciBinding[] {
  const tokenWeight = lexicon.reduce((sum, token) => sum + token.length + (token.gematria ?? 0), 0);
  return [0, 1, 2, 3, 4, 5, 6].map((depth) => {
    const fib = fibonacci(depth);
    const idx = stableIndex(`${seed}\0${sequence.ref}\0${fib}\0${tokenWeight}`, numbers.length);
    const verse = numbers[(sequence.order + idx + fib) % numbers.length];
    return {
      ref: verse.ref,
      text: verse.text,
      hebrewText: numbersHebrewByRef.get(verse.ref) ?? null,
      fibonacci: fib,
      depth,
    };
  });
}

export async function bindContractToTorah(
  contract: { id: string; text: string },
  opts: { corpusRoot?: string; position?: { index: number; total: number } } = {},
): Promise<ContractTorahBinding> {
  const corpusRoot = opts.corpusRoot ?? TORAH_CORPUS_ROOT;
  const torah = await loadTorahCorpus(corpusRoot);
  const torahHebrewByRef = await loadTorahHebrewByRef(corpusRoot);
  const numbers = await loadNumbersCorpus(corpusRoot);
  const numbersHebrewByRef = await loadNumbersHebrewByRef(corpusRoot);
  const sequence = torah[sequenceIndex(`${contract.id}\0${contract.text}`, torah.length, opts.position)];
  if (!sequence) throw new Error(`no Torah sequence anchor for ${contract.id}`);
  const lexicon = [...englishTokens(sequence.text), ...hebrewTokens(torahHebrewByRef.get(sequence.ref) ?? null)];

  const embed = hashEmbedder(256);
  const q = await embed.embed(contract.text);
  let best: TorahVerse | null = null;
  let bestScore = -1;
  for (const verse of torah) {
    const score = cosine(q, await embed.embed(`${verse.ref} ${verse.text}`));
    if (score > bestScore) {
      best = verse;
      bestScore = score;
    }
  }
  if (!best || bestScore <= 0) throw new Error(`no semantic Torah witness for ${contract.id}`);

  let nativeBibleAnchorIndex: number | null = null;
  try {
    nativeBibleAnchorIndex = bibleAnchorNative(contract.text);
  } catch {
    nativeBibleAnchorIndex = null;
  }

  return {
    root: "torah",
    corpusRoot,
    sequence,
    semantic: { ...best, score: Number(bestScore.toFixed(6)) },
    timeGradient: timeGradient(torah, sequence, opts.position),
    ast: verseAst(sequence, lexicon),
    lexicon,
    numbersFibonacci: numbersFibonacciBindings(contract.id, sequence, lexicon, numbers, numbersHebrewByRef),
    nativeBibleAnchorIndex,
  };
}

export function torahBindingText(binding: ContractTorahBinding): string {
  return [
    `torah.sequence=${binding.sequence.ref}: ${binding.sequence.text}`,
    `torah.gradient=${binding.timeGradient.direction}:${binding.timeGradient.progress}:${binding.timeGradient.currentRef}`,
    `torah.semantic=${binding.semantic.ref}: ${binding.semantic.text}`,
    `torah.numbers_fibonacci=${binding.numbersFibonacci.map((row) => `${row.fibonacci}:${row.ref}`).join(",")}`,
    `torah.lexicon=${binding.lexicon.slice(0, 12).map((token) => `${token.language}:${token.normalized}`).join(",")}`,
    binding.nativeBibleAnchorIndex === null ? "torah.native_bible_anchor=null" : `torah.native_bible_anchor=${binding.nativeBibleAnchorIndex}`,
  ].join("\n");
}
