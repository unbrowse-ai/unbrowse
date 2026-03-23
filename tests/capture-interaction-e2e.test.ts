import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { captureSession } from "../src/capture/index.js";

const servers = new Set<ReturnType<typeof createServer>>();

async function startInteractiveSearchServer(): Promise<{
  url: string;
  requests: string[];
}> {
  const requests: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const parsed = new URL(req.url || "/", "http://127.0.0.1");
    requests.push(parsed.pathname + parsed.search);

    if (parsed.pathname === "/discover") {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html>
<html>
  <body>
    <main>
      <label>
        Search
        <input id="searchbox" type="search" placeholder="Search events" />
      </label>
      <button id="go" type="button">Search</button>
      <script>
        const input = document.getElementById("searchbox");
        const run = () =>
          fetch("/api/search?q=" + encodeURIComponent(input.value || ""), {
            headers: { accept: "application/json" },
          })
            .then((response) => response.json())
            .then((data) => {
              document.body.setAttribute("data-last-query", data.query || "");
            });
        document.getElementById("go").addEventListener("click", run);
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            run();
          }
        });
      </script>
    </main>
  </body>
</html>`);
      return;
    }

    if (parsed.pathname === "/api/search") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        query: parsed.searchParams.get("q"),
        results: [{ title: "AI Singapore Builders", city: "Singapore" }],
      }));
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
    url: `http://127.0.0.1:${port}/discover`,
    requests,
  };
}

async function startInteractiveBookingServer(): Promise<{
  url: string;
  requests: string[];
}> {
  const requests: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const parsed = new URL(req.url || "/", "http://127.0.0.1");
    requests.push(parsed.pathname + parsed.search);

    if (parsed.pathname === "/event") {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html>
<html>
  <body>
    <main>
      <h1>AI Builders Dinner</h1>
      <button id="register" type="button">Request to Join</button>
      <div id="sheet"></div>
      <script>
        document.getElementById("register").addEventListener("click", () => {
          setTimeout(() => {
            fetch("/api/register-context", {
              headers: { accept: "application/json" },
            })
              .then((response) => response.json())
              .then((data) => {
                document.getElementById("sheet").innerHTML =
                  '<form><input type="email" placeholder="you@email.com" /><button type="submit">' +
                  data.cta +
                  "</button></form>";
              });
          }, 1800);
        });
      </script>
    </main>
  </body>
</html>`);
      return;
    }

    if (parsed.pathname === "/api/register-context") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        cta: "Request to Join",
      }));
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
    url: `http://127.0.0.1:${port}/event`,
    requests,
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

describe("capture interaction e2e", () => {
  it("uses Kuri interaction to trigger search requests that are not present on initial load", async () => {
    const fixture = await startInteractiveSearchServer();

    const captured = await captureSession(
      fixture.url,
      undefined,
      [],
      'search for "AI Singapore" events',
      { forceEphemeral: true },
    );

    const capturedUrls = captured.requests.map((request) => request.url);
    expect(capturedUrls).toContain("/api/search?q=AI%20Singapore");
    expect(fixture.requests).toContain("/api/search?q=AI%20Singapore");
    expect(captured.html ?? "").toContain('data-last-query="AI Singapore"');
  }, 30_000);

  it("waits long enough after RSVP clicks to capture delayed booking APIs", async () => {
    const fixture = await startInteractiveBookingServer();

    const captured = await captureSession(
      fixture.url,
      undefined,
      [],
      "register RSVP for this event",
      { forceEphemeral: true },
    );

    const capturedUrls = captured.requests.map((request) => request.url);
    expect(capturedUrls).toContain("/api/register-context");
    expect(fixture.requests).toContain("/api/register-context");
    expect(captured.html ?? "").toContain('placeholder="you@email.com"');
  }, 30_000);
});
