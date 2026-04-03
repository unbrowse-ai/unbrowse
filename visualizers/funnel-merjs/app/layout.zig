const std = @import("std");
const mer = @import("mer");

pub fn wrap(allocator: std.mem.Allocator, path: []const u8, body: []const u8, meta: mer.Meta) []const u8 {
    _ = path;
    const title = if (meta.title.len > 0) meta.title else "Unbrowse Funnel";
    const desc = if (meta.description.len > 0) meta.description else "Whole-funnel visualization for Unbrowse.";

    var buf: std.ArrayList(u8) = .{};
    const w = buf.writer(allocator);

    w.writeAll(
        \\<!DOCTYPE html>
        \\<html lang="en">
        \\<head>
        \\  <meta charset="UTF-8">
        \\  <meta name="viewport" content="width=device-width, initial-scale=1.0">
        \\  <meta name="color-scheme" content="dark">
        \\
    ) catch return body;

    w.print("  <title>{s}</title>\n", .{title}) catch return body;
    w.print("  <meta name=\"description\" content=\"{s}\">\n", .{desc}) catch return body;

    w.writeAll(
        \\  <link rel="preconnect" href="https://fonts.googleapis.com">
        \\  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        \\  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
        \\  <style>
        \\    :root {
        \\      --bg: #120f0d;
        \\      --panel: rgba(28, 22, 19, 0.92);
        \\      --panel-2: rgba(44, 33, 28, 0.82);
        \\      --line: rgba(255, 214, 170, 0.12);
        \\      --text: #f6ebdf;
        \\      --muted: #b89f8b;
        \\      --accent: #ff8a3d;
        \\      --accent-soft: rgba(255, 138, 61, 0.18);
        \\      --danger: #ff5b4d;
        \\      --good: #7ce38b;
        \\      --shadow: 0 30px 80px rgba(0, 0, 0, 0.4);
        \\    }
        \\    * { box-sizing: border-box; }
        \\    html, body { margin: 0; min-height: 100%; background: radial-gradient(circle at top left, rgba(255,138,61,0.2), transparent 30%), linear-gradient(180deg, #171210 0%, #0d0a09 100%); color: var(--text); }
        \\    body { font-family: "Space Grotesk", sans-serif; }
        \\    a { color: inherit; text-decoration: none; }
        \\    code, pre, .mono { font-family: "IBM Plex Mono", monospace; }
        \\    .shell { max-width: 1380px; margin: 0 auto; padding: 32px 20px 72px; }
        \\    .masthead {
        \\      display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 26px;
        \\    }
        \\    .brand-kicker { font: 500 11px/1 "IBM Plex Mono", monospace; letter-spacing: 0.18em; text-transform: uppercase; color: var(--accent); margin-bottom: 10px; }
        \\    .brand-title { font-size: clamp(2.2rem, 4vw, 4.8rem); line-height: 0.95; margin: 0; max-width: 720px; letter-spacing: -0.05em; }
        \\    .brand-sub { margin: 14px 0 0; max-width: 720px; color: var(--muted); font-size: 1rem; line-height: 1.55; }
        \\    .meta-rail {
        \\      display: grid; gap: 10px; min-width: 220px; justify-items: end;
        \\    }
        \\    .meta-pill {
        \\      border: 1px solid var(--line); border-radius: 999px; padding: 10px 14px; background: rgba(255,255,255,0.03);
        \\      font: 500 11px/1 "IBM Plex Mono", monospace; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase;
        \\    }
        \\    .frame { border: 1px solid var(--line); border-radius: 28px; background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01)); box-shadow: var(--shadow); overflow: hidden; }
        \\    .frame-inner { padding: 24px; }
        \\    @media (max-width: 900px) {
        \\      .masthead { flex-direction: column; }
        \\      .meta-rail { justify-items: start; min-width: 0; }
        \\    }
        \\  </style>
        \\
    ) catch return body;

    if (meta.extra_head) |extra| {
        w.writeAll(extra) catch {};
        w.writeAll("\n") catch {};
    }

    w.writeAll(
        \\</head>
        \\<body>
        \\  <div class="shell">
        \\    <header class="masthead">
        \\      <div>
        \\        <div class="brand-kicker">Foundry Visual Surface</div>
        \\        <h1 class="brand-title">Unbrowse funnel, end to end.</h1>
        \\        <p class="brand-sub">merjs shell. one snapshot API. distribution, landing, install, activation, retention, leaks. enough to decide what to tighten next without digging through six endpoints by hand.</p>
        \\      </div>
        \\      <div class="meta-rail">
        \\        <div class="meta-pill">merjs sidecar</div>
        \\        <div class="meta-pill">no next runtime</div>
        \\        <div class="meta-pill">foundry-compatible</div>
        \\      </div>
        \\    </header>
        \\    <main class="frame">
        \\      <div class="frame-inner">
        \\
    ) catch return body;

    w.writeAll(body) catch return body;

    w.writeAll(
        \\
        \\      </div>
        \\    </main>
        \\  </div>
        \\</body>
        \\</html>
    ) catch return body;

    return buf.items;
}
