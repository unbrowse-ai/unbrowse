import { describe, expect, test } from "bun:test";
import { PAPERS, papersByTheme } from "./papers";

describe("papers vessel", () => {
  test('only the flagship "Internal APIs Are All You Need" paper is published', () => {
    expect(PAPERS).toHaveLength(1);
    expect(PAPERS[0].id).toBe("internal-apis-are-all-you-need");
  });

  test("no companion papers remain — every theme resolves to an empty set", () => {
    expect(papersByTheme("zk-privacy")).toHaveLength(0);
    expect(papersByTheme("economy")).toHaveLength(0);
  });

  test('"Internal APIs Are All You Need" has no themes', () => {
    const paper = PAPERS.find((p) => p.id === "internal-apis-are-all-you-need");
    expect(paper).toBeDefined();
    expect(paper!.themes).toEqual([]);
  });

  test("every PAPERS entry has a non-empty id, title, href, description", () => {
    expect(PAPERS.length).toBeGreaterThan(0);
    for (const paper of PAPERS) {
      expect(paper.id.length).toBeGreaterThan(0);
      expect(paper.title.length).toBeGreaterThan(0);
      expect(paper.href.length).toBeGreaterThan(0);
      expect(paper.description.length).toBeGreaterThan(0);
    }
  });

  test("all ids are unique", () => {
    const ids = PAPERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every pdf:true paper href ends with ".pdf"', () => {
    for (const paper of PAPERS.filter((p) => p.pdf)) {
      expect(paper.href.endsWith(".pdf")).toBe(true);
    }
  });
});
