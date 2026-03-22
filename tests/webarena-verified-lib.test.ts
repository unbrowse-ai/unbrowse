import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import {
  judgeWebArenaTask,
  loadWebArenaVerifiedTasks,
  renderTaskStartUrls,
  resolveWebArenaEnvMap,
} from "../evals/webarena-verified-lib.js";

function makeRepoFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "webarena-verified-fixture-"));
  mkdirSync(join(root, "assets", "dataset", "subsets"), { recursive: true });
  writeFileSync(join(root, "assets", "dataset", "webarena-verified.json"), JSON.stringify([
    {
      task_id: 44,
      sites: ["gitlab"],
      start_urls: ["__GITLAB__"],
      intent: "Open my todos page",
      eval: [
        {
          evaluator: "AgentResponseEvaluator",
          expected: {
            task_type: "navigate",
            status: "SUCCESS",
            retrieved_data: null,
          },
        },
        {
          evaluator: "NetworkEventEvaluator",
          expected: {
            url: "__GITLAB__/dashboard/todos",
            http_method: "GET",
          },
        },
      ],
    },
    {
      task_id: 108,
      sites: ["shopping_admin"],
      start_urls: ["__SHOPPING_ADMIN__"],
      intent: "Get top seller",
      eval: [
        {
          evaluator: "AgentResponseEvaluator",
          expected: {
            task_type: "retrieve",
            status: "SUCCESS",
            retrieved_data: ["Quest Lumaflex Band"],
          },
        },
      ],
    },
  ], null, 2));
  writeFileSync(join(root, "assets", "dataset", "subsets", "webarena-verified-hard.json"), JSON.stringify({
    task_ids: [44],
  }, null, 2));
  return root;
}

describe("webarena verified lib", () => {
  it("loads full and hard subsets from the official dataset shape", () => {
    const repo = makeRepoFixture();
    try {
      const full = loadWebArenaVerifiedTasks({ repo_dir: repo, subset: "full" });
      const hard = loadWebArenaVerifiedTasks({ repo_dir: repo, subset: "hard" });
      expect(full.map((task) => task.task_id)).toEqual([44, 108]);
      expect(hard.map((task) => task.task_id)).toEqual([44]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("renders templated start urls from env config", () => {
    const env = resolveWebArenaEnvMap({
      overrides: {
        __GITLAB__: "http://localhost:8023",
      },
    });
    const [url] = renderTaskStartUrls({
      task_id: 44,
      sites: ["gitlab"],
      start_urls: ["__GITLAB__/dashboard/todos"],
      intent: "Open my todos page",
      agent: {
        task_type: "navigate",
        status: "SUCCESS",
        retrieved_data: null,
      },
      network: [],
    }, env);
    expect(url).toBe("http://localhost:8023/dashboard/todos");
  });

  it("judges retrieval, selection, network, and execution on benchmark-style evidence", () => {
    const env = resolveWebArenaEnvMap({
      overrides: {
        __GITLAB__: "http://localhost:8023",
      },
    });
    const task = {
      task_id: 44,
      sites: ["gitlab"],
      start_urls: ["__GITLAB__"],
      intent: "Open my todos page",
      agent: {
        task_type: "navigate" as const,
        status: "SUCCESS" as const,
        retrieved_data: null,
      },
      network: [
        {
          url: "__GITLAB__/dashboard/todos",
          http_method: "GET",
          response_status: 200,
        },
      ],
    };
    const verdict = judgeWebArenaTask({
      task,
      env,
      available_endpoints: [
        {
          endpoint_id: "todos",
          url: "http://localhost:8023/dashboard/todos",
          description: "dashboard todos",
        },
      ],
      selected_endpoint: {
        endpoint_id: "todos",
        url: "http://localhost:8023/dashboard/todos",
        description: "dashboard todos",
      },
      network_events: [
        {
          startedDateTime: new Date().toISOString(),
          request: {
            url: "http://localhost:8023/dashboard/todos",
            method: "GET",
            headers: [],
          },
          response: {
            status: 200,
            headers: [],
          },
        },
      ],
      agent_status: "SUCCESS",
      retrieved_data: null,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it("accepts alias groups in retrieved_data expectations", () => {
    const env = resolveWebArenaEnvMap();
    const task = {
      task_id: 21,
      sites: ["shopping"],
      start_urls: ["__SHOPPING__/headphones.html"],
      intent: "Get name(s) of reviewer(s) who mention ear cups being small for the product on the current page",
      agent: {
        task_type: "retrieve" as const,
        status: "SUCCESS" as const,
        retrieved_data: [
          "Catso",
          "Dibbins",
          ["Anglebert Dinkherhump", "Anglebert", "Dinkherhump"],
          ["Michelle Davis", "Michelle DavisMichelle Davis"],
        ],
      },
      network: [],
    };
    const verdict = judgeWebArenaTask({
      task,
      env,
      available_endpoints: [],
      network_events: [],
      agent_status: "SUCCESS",
      retrieved_data: [
        "Catso",
        "Dibbins",
        "Anglebert Dinkherhump",
        "Michelle DavisMichelle Davis",
      ],
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });
});
