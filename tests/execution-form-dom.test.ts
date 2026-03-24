import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { executeSkill } from "../src/execution/index.js";
import type { SkillManifest } from "../src/types/index.js";

const servers = new Set<ReturnType<typeof createServer>>();

async function startExecutionServer(): Promise<{
  actionUrl: string;
  seenBodies: string[];
}> {
  const seenBodies: string[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const parsed = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "POST" && parsed.pathname === "/result-page") {
      if (parsed.searchParams.get("action") !== "basicSearch") {
        res.setHeader("content-type", "text/html");
        res.end(`<!doctype html>
<html>
  <body>
    <nav>
      <a href="/about">About LawNet Legal Research</a>
      <p>General information page</p>
    </nav>
  </body>
</html>`);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      seenBodies.push(body);
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html>
<html>
  <body>
    <main>
      <article>
        <a href="/cases/1">Case One v Two [2024] SGHC 1</a>
        <p>${body}</p>
      </article>
      <article>
        <a href="/cases/2">Case Three v Four [2023] SGHC 2</a>
        <p>Fresh evidence after damages hearing started</p>
      </article>
    </main>
  </body>
</html>`);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    actionUrl: `http://127.0.0.1:${port}/result-page?action=basicSearch`,
    seenBodies,
  };
}

afterEach(async () => {
  await Promise.all(
    [...servers].map((server) =>
      new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
    ),
  );
  servers.clear();
});

describe("executeSkill form-urlencoded DOM endpoint", () => {
  it("replays form bodies as application/x-www-form-urlencoded and extracts structured rows", async () => {
    const fixture = await startExecutionServer();
    const now = new Date().toISOString();
    const skill: SkillManifest = {
      skill_id: "lawnet-form",
      version: "1.0.0",
      schema_version: "1",
      lifecycle: "active",
      execution_type: "http",
      created_at: now,
      updated_at: now,
      name: "generic-html.test",
      intent_signature: "search for high court case assessment of damages new evidence adduced after tranches started",
      domain: "generic-html.test",
      description: "lawnet form skill",
      owner_type: "agent",
      endpoints: [
        {
          endpoint_id: "search-form",
          method: "POST",
          url_template: fixture.actionUrl,
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.9,
          headers_template: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: {
            grouping: "1",
            category: ["1", "2"],
            basicSearchKey: "{basicSearchKey}",
          },
          body_params: {
            basicSearchKey: "assessment of damages new evidence",
          },
          dom_extraction: {
            extraction_method: "repeated-elements",
            confidence: 0.8,
            selector: "article",
          },
          response_schema: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                url: { type: "string" },
                description: { type: "string" },
              },
            },
          } as any,
        } as any,
      ],
    };

    const out = await executeSkill(skill, {}, undefined, {
      intent: skill.intent_signature,
      confirm_unsafe: true,
    });

    expect(out.trace.success).toBe(true);
    expect(fixture.seenBodies[0]).toContain("grouping=1");
    expect(fixture.seenBodies[0]).toContain("category=1");
    expect(fixture.seenBodies[0]).toContain("category=2");
    expect(fixture.seenBodies[0]).toContain("basicSearchKey=assessment+of+damages+new+evidence");
    expect((out.result as Array<Record<string, unknown>>)[0]?.title).toContain("Case One v Two");
  });

  it("replays query defaults from semantic sample_request_url when the url_template dropped them", async () => {
    const fixture = await startExecutionServer();
    const now = new Date().toISOString();
    const bareActionUrl = fixture.actionUrl.split("?")[0];
    const skill: SkillManifest = {
      skill_id: "lawnet-form-query-fallback",
      version: "1.0.0",
      schema_version: "1",
      lifecycle: "active",
      execution_type: "http",
      created_at: now,
      updated_at: now,
      name: "127.0.0.1",
      intent_signature: "search for high court case assessment of damages new evidence adduced after tranches started",
      domain: "127.0.0.1",
      description: "lawnet form skill",
      owner_type: "agent",
      endpoints: [
        {
          endpoint_id: "search-form-query-fallback",
          method: "POST",
          url_template: bareActionUrl,
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.9,
          headers_template: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: {
            grouping: "1",
            category: ["1", "2"],
            basicSearchKey: "{basicSearchKey}",
          },
          body_params: {
            basicSearchKey: "assessment of damages new evidence",
          },
          dom_extraction: {
            extraction_method: "repeated-elements",
            confidence: 0.8,
            selector: "article",
          },
          response_schema: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                url: { type: "string" },
                description: { type: "string" },
              },
            },
          } as any,
          semantic: {
            action_kind: "search",
            resource_kind: "document",
            description_in: "Requires basicSearchKey",
            description_out: "Searches documents with title, url, description",
            response_summary: "[].title, [].url, [].description",
            example_request: { basicSearchKey: "{basicSearchKey}" },
            example_response_compact: [{ title: "Case One v Two [2024] SGHC 1" }],
            example_fields: ["[].title", "[].url"],
            requires: [],
            provides: [],
            negative_tags: [],
            confidence: 0.8,
            observed_at: now,
            sample_request_url: fixture.actionUrl,
            auth_required: true,
          },
        } as any,
      ],
    };

    const out = await executeSkill(skill, {}, undefined, {
      intent: skill.intent_signature,
      confirm_unsafe: true,
    });

    expect(out.trace.success).toBe(true);
    expect(out.trace.network_events?.[0]?.request?.url).toContain("?action=basicSearch");
    expect((out.result as Array<Record<string, unknown>>)[0]?.title).toContain("Case One v Two");
  });
});
