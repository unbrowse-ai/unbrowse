import { describe, it, expect } from "bun:test";
import { inferDependencyDagFromHarEntries } from "../src/dependency-dag.js";
import type { HarEntry } from "../src/types.js";

function harEntry(init: {
  method: string;
  url: string;
  requestBody?: any;
  responseBody?: any;
  time?: number;
}): HarEntry {
  return {
    request: {
      method: init.method,
      url: init.url,
      headers: [],
      cookies: [],
      postData: init.requestBody !== undefined
        ? { mimeType: "application/json", text: JSON.stringify(init.requestBody) }
        : undefined,
    },
    response: {
      status: 200,
      headers: [],
      content: init.responseBody !== undefined
        ? { mimeType: "application/json", text: JSON.stringify(init.responseBody) }
        : undefined,
    },
    time: init.time,
  };
}

describe("dependency-dag", () => {
  it("infers edge when response id is used in later request body", () => {
    const entries: HarEntry[] = [
      harEntry({
        method: "POST",
        url: "https://api.example.com/v1/projects",
        requestBody: { name: "alpha" },
        responseBody: { project: { id: "p_123", name: "alpha" } },
        time: 1,
      }),
      harEntry({
        method: "GET",
        url: "https://api.example.com/v1/projects/p_123",
        time: 2,
      }),
      harEntry({
        method: "POST",
        url: "https://api.example.com/v1/tasks",
        requestBody: { projectId: "p_123", title: "t1" },
        responseBody: { id: "t_9" },
        time: 3,
      }),
    ];

    const dag = inferDependencyDagFromHarEntries(entries, { skillName: "example" });

    const e = dag.edges.find((x) =>
      x.from === "POST /v1/projects" && x.to === "POST /v1/tasks"
    );
    expect(e).toBeTruthy();
    expect(e?.hasValueMatch).toBe(true);
    expect(e?.confidence).toBeGreaterThan(0.6);
  });

  it("does not create self-edges", () => {
    const entries: HarEntry[] = [
      harEntry({
        method: "GET",
        url: "https://api.example.com/v1/me",
        responseBody: { id: "u_1" },
        time: 1,
      }),
      harEntry({
        method: "GET",
        url: "https://api.example.com/v1/me",
        responseBody: { id: "u_1" },
        time: 2,
      }),
    ];
    const dag = inferDependencyDagFromHarEntries(entries);
    expect(dag.edges.length).toBe(0);
  });
});

