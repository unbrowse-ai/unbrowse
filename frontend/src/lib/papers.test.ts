import { describe, expect, test } from "bun:test";
import { PAPERS, papersByTheme } from "./papers";

describe("papers vessel", () => {
  test('papersByTheme("zk-privacy") returns exactly the "Crypto Was All You Needed" paper', () => {
    const result = papersByTheme("zk-privacy");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("crypto-was-all-you-needed");
    expect(result[0].title).toBe("Crypto Was All You Needed");
  });

  test('papersByTheme("economy") returns exactly the "Unbrowse Maintenance Network" paper', () => {
    const result = papersByTheme("economy");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("unbrowse-maintenance-network");
    expect(result[0].title).toBe("Unbrowse Maintenance Network");
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
