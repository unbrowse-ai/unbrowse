"use client";

import { useState, useEffect } from "react";

const O      = "#FF7A20";          // main phosphor orange
const O_DIM  = "rgba(255,122,32,0.40)";
const O_HI   = "#FFB060";          // bright highlights
const O_GLOW = "0 0 8px rgba(255,122,32,0.75)";
const BG     = "#060402";

type LineType = "header" | "divider" | "comment" | "cmd" | "blank";
interface TLine { type: LineType; text: string; }

const TABS = [
  {
    id: "claude",
    label: "CLAUDE / OPENCLAW",
    copyText: "npx unbrowse setup",
    lines: [
      { type: "header",  text: "▸  UNBROWSE SETUP  ·  CLAUDE CODE + OPENCLAW" },
      { type: "divider", text: "──────────────────────────────────────────────" },
      { type: "comment", text: "  ##  one-command full setup" },
      { type: "cmd",     text: "  $  npx unbrowse setup" },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  install globally + wire host" },
      { type: "cmd",     text: "  $  npm install -g unbrowse" },
      { type: "cmd",     text: "  $  unbrowse setup" },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  already installed?  upgrade" },
      { type: "cmd",     text: "  $  npm install -g unbrowse@latest && unbrowse setup" },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  add skill for agent workflows" },
      { type: "cmd",     text: "  $  npx skills add unbrowse-ai/unbrowse" },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  invoke" },
      { type: "cmd",     text: '  $  unbrowse resolve --intent "get events" --url "lu.ma"' },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  earn from discovered routes — set up Crossmint lobster.cash" },
      { type: "cmd",     text: "  $  unbrowse wallet setup" },
    ] as TLine[],
  },
  {
    id: "cursor",
    label: "CURSOR",
    copyText: "npx unbrowse setup",
    lines: [
      { type: "header",  text: "▸  UNBROWSE SETUP  ·  CURSOR" },
      { type: "divider", text: "──────────────────────────────────────────────" },
      { type: "comment", text: "  ##  one-command full setup" },
      { type: "cmd",     text: "  $  npx unbrowse setup" },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  install globally" },
      { type: "cmd",     text: "  $  npm install -g unbrowse" },
      { type: "cmd",     text: "  $  unbrowse setup" },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  upgrade existing install" },
      { type: "cmd",     text: "  $  npm install -g unbrowse@latest && unbrowse setup" },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  add skill in cursor" },
      { type: "cmd",     text: "  $  npx skills add unbrowse-ai/unbrowse" },
      { type: "blank",   text: "" },
      { type: "comment", text: "  ##  verify" },
      { type: "cmd",     text: "  $  unbrowse health" },
    ] as TLine[],
  },
] as const;

function lineStyle(type: LineType): React.CSSProperties {
  switch (type) {
    case "header":
      return { color: O_HI, textShadow: "0 0 12px rgba(255,176,96,0.9)", fontWeight: "bold", letterSpacing: "0.04em" };
    case "divider":
      return { color: "rgba(255,122,32,0.28)", letterSpacing: "0" };
    case "comment":
      return { color: O_DIM, fontStyle: "italic" };
    case "cmd":
      return { color: O, textShadow: O_GLOW };
    case "blank":
      return { height: "0.55em", display: "block" };
  }
}

export function InstallInstructions() {
  const [active, setActive]       = useState<string>("claude");
  const [visible, setVisible]     = useState(0);
  const [cursor, setCursor]       = useState(true);
  const [copied, setCopied]       = useState(false);

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
        background: BG,
        border: "1px solid rgba(255,122,32,0.5)",
        borderRadius: "3px",
        boxShadow: "0 0 40px rgba(255,82,0,0.10), inset 0 0 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,82,0,0.06)",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* CRT scanlines */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute", inset: 0, pointerEvents: "none", zIndex: 20,
          backgroundImage: "repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(0,0,0,0.28) 2px, rgba(0,0,0,0.28) 3px)",
        }}
      />

      {/* Phosphor vignette */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute", inset: 0, pointerEvents: "none", zIndex: 18,
          background: "radial-gradient(ellipse at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)",
        }}
      />

      {/* ── Toolbar ── */}
      <div
        style={{
          borderBottom: "1px solid rgba(255,122,32,0.22)",
          padding: "7px 12px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "rgba(0,0,0,0.35)",
          position: "relative", zIndex: 30,
        }}
      >
        {/* Status dot + title */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: O, boxShadow: `0 0 6px ${O}` }} />
          <span style={{ fontFamily: "monospace", fontSize: 10, color: O_DIM, letterSpacing: "0.18em", textTransform: "uppercase" }}>
            unbrowse terminal
          </span>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 6 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              style={{
                fontFamily: "monospace", fontSize: 10, letterSpacing: "0.12em",
                padding: "2px 10px",
                border: `1px solid ${active === t.id ? "rgba(255,122,32,0.65)" : "rgba(255,122,32,0.18)"}`,
                background: active === t.id ? "rgba(255,122,32,0.11)" : "transparent",
                color: active === t.id ? O_HI : O_DIM,
                textShadow: active === t.id ? O_GLOW : "none",
                borderRadius: 2, cursor: "pointer",
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
            border: `1px solid ${copied ? "rgba(255,176,96,0.5)" : "rgba(255,122,32,0.22)"}`,
            background: copied ? "rgba(255,176,96,0.1)" : "transparent",
            color: copied ? O_HI : O_DIM,
            borderRadius: 2, cursor: "pointer",
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
          fontSize: "12.5px",
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
          <div style={{ color: O, textShadow: O_GLOW, marginTop: "2px" }}>
            {"  $  "}
            <span style={{ opacity: cursor ? 1 : 0, transition: "opacity 60ms" }}>█</span>
          </div>
        )}
      </div>
    </div>
  );
}
