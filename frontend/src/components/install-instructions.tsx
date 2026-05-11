"use client";

import { useState, useEffect } from "react";

const O      = "#8B3800";          // dark burnt orange (commands on parchment)
const O_DIM  = "rgba(100,55,10,0.75)";  // dim text (comments, labels)
const O_HI   = "#5C1E00";          // dark brown (headers, active)
const BG        = "#ede0c2";       // warm parchment/beige
const BG_MOBILE = "#e8d8b0";

type LineType = "header" | "divider" | "comment" | "cmd" | "blank";
interface TLine { type: LineType; text: string; }

const TABS = [
  {
    id: "claude-code",
    label: "CLAUDE CODE",
    copyText: "npx unbrowse setup --mcp",
    lines: [
      { type: "header",  text: "▸  UNBROWSE MCP  ·  CLAUDE CODE" },
      { type: "divider", text: "──────────────────────────────────────────────" },
      { type: "comment", text: "  ##  one command — installs + registers MCP server" },
      { type: "cmd",     text: "  $  npx unbrowse setup --mcp" },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  or wire manually" },
      { type: "cmd",     text: "  $  claude mcp add unbrowse -- npx -y unbrowse mcp" },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  upgrade existing install" },
      { type: "cmd",     text: "  $  npm install -g unbrowse@latest && unbrowse setup --mcp" },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  then, from inside claude" },
      { type: "cmd",     text: '  >  resolve "get events" on lu.ma, then execute the top result' },
    ] as TLine[],
  },
  {
    id: "cursor",
    label: "CURSOR / WINDSURF",
    copyText: "npx unbrowse setup --mcp",
    lines: [
      { type: "header",  text: "▸  UNBROWSE MCP  ·  CURSOR / WINDSURF / CLAUDE DESKTOP" },
      { type: "divider", text: "──────────────────────────────────────────────" },
      { type: "comment", text: "  ##  auto-detect + wire the MCP server" },
      { type: "cmd",     text: "  $  npx unbrowse setup --mcp" },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  manual: add to your mcp config" },
      { type: "cmd",     text: '  {  "unbrowse": { "command": "npx", "args": ["-y", "unbrowse", "mcp"] }  }' },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  verify the server is healthy" },
      { type: "cmd",     text: "  $  unbrowse health" },
    ] as TLine[],
  },
  {
    id: "codex",
    label: "CODEX / OPENCLAW",
    copyText: "npx unbrowse setup --mcp",
    lines: [
      { type: "header",  text: "▸  UNBROWSE MCP  ·  CODEX + OPENCLAW + ANY MCP CLIENT" },
      { type: "divider", text: "──────────────────────────────────────────────" },
      { type: "comment", text: "  ##  install + register" },
      { type: "cmd",     text: "  $  npx unbrowse setup --mcp" },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  stdio transport for any other client" },
      { type: "cmd",     text: "  $  unbrowse mcp" },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  earn from discovered routes" },
      { type: "cmd",     text: "  $  npx @crossmint/lobster-cli setup" },
    ] as TLine[],
  },
  {
    id: "cli",
    label: "CLI (LEGACY)",
    copyText: "npm install -g unbrowse && unbrowse setup",
    lines: [
      { type: "header",  text: "▸  CLI FALLBACK  ·  STILL SUPPORTED" },
      { type: "divider", text: "──────────────────────────────────────────────" },
      { type: "comment", text: "  ##  MCP is the default — use the CLI only if your" },
      { type: "comment", text: "  ##  host can't speak MCP, or for one-off shell use." },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  install globally" },
      { type: "cmd",     text: "  $  npm install -g unbrowse" },
      { type: "cmd",     text: "  $  unbrowse setup" },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  invoke from a shell" },
      { type: "cmd",     text: '  $  unbrowse resolve --intent "get events" --url "lu.ma"' },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  upgrade later" },
      { type: "cmd",     text: "  $  npm install -g unbrowse@latest && unbrowse setup" },
    ] as TLine[],
  },
] as const;

function lineStyle(type: LineType): React.CSSProperties {
  switch (type) {
    case "header":
      return { color: O_HI, fontWeight: "bold", letterSpacing: "0.04em" };
    case "divider":
      return { color: "rgba(100,55,10,0.4)", letterSpacing: "0" };
    case "comment":
      return { color: O_DIM, fontStyle: "italic", fontWeight: "600" };
    case "cmd":
      return { color: O, fontWeight: "bold" };
    case "blank":
      return { height: "0.55em", display: "block" };
  }
}

export function InstallInstructions() {
  const [active, setActive]       = useState<string>("claude-code");
  const [visible, setVisible]     = useState(0);
  const [cursor, setCursor]       = useState(true);
  const [copied, setCopied]       = useState(false);
  const [isMobile, setIsMobile]   = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const tab = TABS.find((t) => t.id === active)!;

  // Reveal lines one-by-one when tab changes
  useEffect(() => {
    setVisible(0);
    let i = 0;
    const iv = setInterval(() => {
      i++;
      setVisible(i);
      if (i >= tab.lines.length) clearInterval(iv);
    }, 52);
    return () => clearInterval(iv);
  }, [active, tab.lines.length]);

  // Blinking block cursor
  useEffect(() => {
    const iv = setInterval(() => setCursor((v) => !v), 520);
    return () => clearInterval(iv);
  }, []);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(tab.copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      style={{
        background: isMobile ? BG_MOBILE : BG,
        border: "1px solid rgba(255,122,32,0.5)",
        borderRadius: "3px",
        boxShadow: isMobile
          ? "0 0 20px rgba(139,69,19,0.12)"
          : "0 0 40px rgba(139,69,19,0.15), 0 0 0 1px rgba(255,82,0,0.1)",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* CRT scanlines */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute", inset: 0, pointerEvents: "none", zIndex: 20,
          backgroundImage: `repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(0,0,0,${isMobile ? 0.04 : 0.07}) 2px, rgba(0,0,0,${isMobile ? 0.04 : 0.07}) 3px)`,
        }}
      />

      {/* Phosphor vignette */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute", inset: 0, pointerEvents: "none", zIndex: 18,
          background: `radial-gradient(ellipse at 50% 50%, transparent 55%, rgba(100,60,20,${isMobile ? 0.1 : 0.18}) 100%)`,
        }}
      />

      {/* ── Toolbar ── */}
      <div
        style={{
          borderBottom: "1px solid rgba(255,122,32,0.22)",
          padding: "7px 12px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: isMobile ? "8px" : "12px",
          background: isMobile ? "rgba(180,145,90,0.35)" : "rgba(180,145,90,0.28)",
          position: "relative", zIndex: 30,
        }}
      >
        {/* Status dot + title */}
        <div style={{ display: isMobile ? "none" : "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: O }} />
          <span style={{ fontFamily: "monospace", fontSize: 10, color: O_DIM, letterSpacing: "0.18em", textTransform: "uppercase" }}>
            unbrowse mcp
          </span>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              style={{
                fontFamily: "monospace", fontSize: 10, letterSpacing: "0.12em",
                padding: "2px 10px",
                border: `1px solid ${active === t.id ? "rgba(100,45,5,0.5)" : "rgba(100,55,10,0.2)"}`,
                background: active === t.id ? "rgba(139,56,0,0.12)" : "transparent",
                color: active === t.id ? O_HI : O_DIM,
                borderRadius: 2, cursor: "pointer", whiteSpace: "nowrap",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Copy */}
        <button
          onClick={handleCopy}
          style={{
            fontFamily: "monospace", fontSize: 10, letterSpacing: "0.1em",
            padding: "2px 10px",
            border: `1px solid ${copied ? "rgba(92,30,0,0.6)" : "#FF7A20"}`,
            background: copied ? "#FF7A20" : "#FF7A20",
            color: copied ? "#fff" : "#fff",
            borderRadius: 2, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap",
          }}
        >
          {copied ? "COPIED ✓" : "[ COPY ]"}
        </button>
      </div>

      {/* ── Output ── */}
      <div
        style={{
          padding: "14px 18px 18px",
          fontFamily: "'Courier New', 'Lucida Console', monospace",
          fontSize: "13.5px",
          lineHeight: "1.8",
          minHeight: "260px",
          position: "relative", zIndex: 30,
        }}
      >
        {tab.lines.slice(0, visible).map((line, i) =>
          line.type === "blank" ? (
            <div key={i} style={lineStyle("blank")} />
          ) : (
            <div key={i} style={lineStyle(line.type)}>{line.text}</div>
          )
        )}

        {/* Blinking cursor — shown after all lines appear */}
        {visible >= tab.lines.length && (
          <div style={{ color: O, marginTop: "2px" }}>
            {"  $  "}
            <span style={{ opacity: cursor ? 1 : 0, transition: "opacity 60ms" }}>█</span>
          </div>
        )}
      </div>
    </div>
  );
}
