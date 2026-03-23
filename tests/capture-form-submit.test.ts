import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { fetchHtmlDocument, submitLikelyHtmlSearchForm } from "../src/capture/form-submit.js";

const servers = new Set<ReturnType<typeof createServer>>();

async function startSearchFormServer(): Promise<{
  pageUrl: string;
  seenBodies: string[];
}> {
  const seenBodies: string[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const parsed = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && parsed.pathname === "/basic-search") {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html>
<html>
  <body>
    <form action="/login" method="post">
      <input type="text" name="username" />
      <input type="password" name="password" />
      <button type="submit">Login</button>
    </form>
    <form action="/result-page?action=basicSearch" method="post">
      <input type="hidden" name="grouping" value="1" />
      <input type="checkbox" name="category" value="1" checked />
      <input type="checkbox" name="category" value="2" checked />
      <input type="text" name="basicSearchKey" placeholder="Keyword Search" />
      <button type="submit">Search</button>
    </form>
  </body>
</html>`);
      return;
    }

    if (req.method === "POST" && parsed.pathname === "/result-page") {
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
    pageUrl: `http://127.0.0.1:${port}/basic-search`,
    seenBodies,
  };
}

async function startTwoStageSearchServer(): Promise<{
  pageUrl: string;
  seenBodies: string[];
}> {
  const seenBodies: string[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const parsed = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && parsed.pathname === "/basic-search") {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html>
<html>
  <body>
    <form action="/basic-search?action=vldbBasicSearchAction" method="post">
      <input type="radio" name="_search_operation" value="search" checked />
      <input type="text" name="_search_query" placeholder="Search legislation" />
      <input type="submit" name="_search_browse" value="A" />
      <input type="submit" name="_search_browse" value="B" />
      <input type="submit" name="_search_browse" value="C" />
      <input type="submit" name="_search_browse" value="D" />
      <input type="submit" name="_search_browse" value="E" />
      <input type="submit" name="_search_browse" value="F" />
    </form>
    <form action="/result-page?action=basicSearchActionURL" method="post">
      <input type="hidden" name="formDate" value="12345" />
      <input type="text" name="basicSearchKey" placeholder="Keyword Search" />
      <input type="checkbox" name="grouping" value="1" checked />
      <input type="checkbox" name="category" value="1" checked />
      <input type="checkbox" name="category" value="2" checked />
    </form>
  </body>
</html>`);
      return;
    }

    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      seenBodies.push(Buffer.concat(chunks).toString("utf8"));
      res.setHeader("content-type", "text/html");
      res.end("<html><body>ok</body></html>");
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
    pageUrl: `http://127.0.0.1:${port}/basic-search`,
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

describe("html form submit fallback", () => {
  it("prefers the LawNet-style result form over the browse helper form", async () => {
    const fixture = await startTwoStageSearchServer();
    const html = await fetch(fixture.pageUrl).then((response) => response.text());

    const result = await submitLikelyHtmlSearchForm({
      html,
      pageUrl: fixture.pageUrl,
      query: "late evidence assessment of damages",
    });

    expect(result).not.toBeNull();
    expect(result?.request.url).toContain("/result-page?action=basicSearchActionURL");
    expect(result?.request.request_body).toContain("basicSearchKey=late+evidence+assessment+of+damages");
    expect(result?.request.request_body).toContain("grouping=1");
    expect(result?.request.request_body).toContain("category=1");
    expect(fixture.seenBodies[0]).not.toContain("_search_browse=A");
  });

  it("fetches the authenticated html document before form submission when cookies are available", async () => {
    const fixture = await startSearchFormServer();

    const result = await fetchHtmlDocument({
      url: fixture.pageUrl,
      cookies: [{ name: "session", value: "ok", domain: "127.0.0.1" }],
    });

    expect(result).not.toBeNull();
    expect(result?.status).toBe(200);
    expect(result?.html).toContain("basicSearchKey");
  });

  it("submits the most likely search form with defaults and repeated fields preserved", async () => {
    const fixture = await startSearchFormServer();
    const html = await fetch(fixture.pageUrl).then((response) => response.text());

    const result = await submitLikelyHtmlSearchForm({
      html,
      pageUrl: fixture.pageUrl,
      query: "assessment of damages new evidence",
    });

    expect(result).not.toBeNull();
    expect(result?.request.method).toBe("POST");
    expect(result?.request.url).toContain("/result-page?action=basicSearch");
    expect(result?.request.request_body).toContain("basicSearchKey=assessment+of+damages+new+evidence");
    expect(result?.request.request_body).toContain("category=1");
    expect(result?.request.request_body).toContain("category=2");
    expect(fixture.seenBodies[0]).toContain("grouping=1");
    expect(fixture.seenBodies[0]).toContain("category=1");
    expect(fixture.seenBodies[0]).toContain("category=2");
    expect(result?.html).toContain("Case One v Two");
  });
});
