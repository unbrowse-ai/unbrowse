'use client';

/**
 * AgentWireTerminal — Banger Wave 1 (2026-05-26).
 *
 * Above-the-fold scripted agent session. 4 steps, autoplays on first
 * scroll-in (IntersectionObserver), replays on click. Pulls the
 * existing ChatDemo's visual DNA — archival CRT, mono, orange-on-
 * near-black, halftone-anchored — but renders only the condensed,
 * load-bearing exchange so the hero stays under 380px.
 *
 * Why we are not re-using ChatDemo: ChatDemo is 722 LOC and ships
 * with the live "search any domain" backend integration. For the
 * hero we need a deterministic, SSR-safe, height-locked first frame
 * (CLS lock matches the parent's min-height in page.tsx).
 *
 * Height lock: 380px on desktop, 360px on mobile — measured from the
 * worst-case rendered timeline.
 */

import { useEffect, useRef, useState } from "react";

const O      = "#FF7A20";
const O_DIM  = "rgba(255,122,32,0.40)";
const O_HI   = "#FFB060";
const O_GLOW = "0 0 6px rgba(255,176,96,0.5)";
const G      = "#4ADE80";
const BG     = "#060402";

interface Step {
  kind: "user" | "tool" | "footer";
  label?: string;      // tool name
  args?: string;       // tool args summary
  result?: string;     // tool result line
  body?: string;       // user message body
  time: string;
}

const STEPS: Step[] = [
  {
    kind: "user",
    body: "find me a hotel in Tokyo, May 22-26, under $300/night",
    time: "9:14 AM",
  },
  {
    kind: "tool",
    label: "unbrowse_resolve",
    args: '"hotel search tokyo"',
    result: "4 endpoints ranked",
    time: "9:14 AM",
  },
  {
    kind: "tool",
    label: "unbrowse_execute",
    args: "priceline.com:search",
    result: "200 OK · 47 results · 412ms",
    time: "9:14 AM",
  },
  {
    kind: "footer",
    body: "signed in as you · 0 browser tab opened · $0.008 settled via Faremeter Flex",
    time: "",
  },
];

export function AgentWireTerminal() {
  const [visible, setVisible] = useState(0);
  const [done, setDone]       = useState(false);
  const [cursor, setCursor]   = useState(true);
  const ref                   = useRef<HTMLDivElement>(null);

  // Cursor blink for the input bar.
  useEffect(() => {
    const iv = setInterval(() => setCursor((v) => !v), 520);
    return () => clearInterval(iv);
  }, []);

  // Autoplay on first scroll-in. SSR-safe: server renders visible=0 so
  // the first frame is a static intent + cursor, matching the post-
  // animation final-frame footprint via the parent's min-height lock.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && visible === 0 && !done) {
          let n = 0;
          interval = setInterval(() => {
            n++;
            setVisible(n);
            if (n >= STEPS.length) {
              if (interval) clearInterval(interval);
              setDone(true);
            }
          }, 700);
          obs.disconnect();
        }
      },
      { threshold: 0.25 }
    );
    if (ref.current) obs.observe(ref.current);
    return () => {
      obs.disconnect();
      if (interval) clearInterval(interval);
    };
  }, [visible, done]);

  const replay = () => {
    setVisible(0);
    setDone(false);
    // Tick will fire from the IO observer; force one manually since the
    // observer has disconnected.
    let n = 0;
    const interval = setInterval(() => {
      n++;
      setVisible(n);
      if (n >= STEPS.length) {
        clearInterval(interval);
        setDone(true);
      }
    }, 700);
  };

  return (
    <div
      ref={ref}
      className="relative w-full"
      style={{ contain: "layout paint" }}
      aria-label="Scripted agent session showing two MCP tool calls and the footer ribbon"
    >
      <div
        style={{
          background: BG,
          border: "1px solid rgba(255,122,32,0.5)",
          borderRadius: "3px",
          boxShadow:
            "0 0 40px rgba(255,82,0,0.10), inset 0 0 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,82,0,0.06)",
          overflow: "hidden",
          position: "relative",
          minHeight: 360,
        }}
      >
        {/* CRT scanlines */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            zIndex: 20,
            backgroundImage:
              "repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(0,0,0,0.28) 2px, rgba(0,0,0,0.28) 3px)",
          }}
        />
        {/* Phosphor vignette */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            zIndex: 18,
            background:
              "radial-gradient(ellipse at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)",
          }}
        />

        {/* Title bar */}
        <div
          style={{
            borderBottom: "1px solid rgba(255,122,32,0.22)",
            padding: "7px 12px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "rgba(0,0,0,0.35)",
            position: "relative",
            zIndex: 30,
          }}
        >
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 10,
              color: O_DIM,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
            }}
          >
            agent session  //  wire trace
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {done && (
              <button
                onClick={replay}
                type="button"
                style={{
                  fontFamily: "monospace",
                  fontSize: 9,
                  color: O_HI,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  background: "none",
                  border: "1px solid rgba(255,122,32,0.35)",
                  padding: "2px 6px",
                  cursor: "pointer",
                }}
                aria-label="Replay the agent session"
              >
                [ replay ]
              </button>
            )}
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: done ? G : O,
                boxShadow: done
                  ? "0 0 6px rgba(74,222,128,0.7)"
                  : `0 0 6px ${O}`,
              }}
            />
            <span
              style={{
                fontFamily: "monospace",
                fontSize: 10,
                color: done ? G : O_DIM,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              {done ? "complete" : "running"}
            </span>
          </div>
        </div>

        {/* Messages */}
        <div
          style={{
            padding: "16px",
            minHeight: 260,
            maxHeight: 320,
            overflowY: "auto",
            position: "relative",
            zIndex: 30,
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          {STEPS.slice(0, visible).map((step, i) => {
            if (step.kind === "user") {
              return (
                <div key={i} className="flex flex-col items-end">
                  <div
                    className="max-w-[95%] sm:max-w-[88%] px-4 py-3 text-sm leading-relaxed"
                    style={{
                      background: "rgba(255,122,32,0.14)",
                      border: "1px solid rgba(255,122,32,0.45)",
                      borderRadius: 2,
                      color: O_HI,
                      fontFamily: "monospace",
                      fontSize: 13,
                      textShadow: "0 0 6px rgba(255,176,96,0.3)",
                    }}
                  >
                    {step.body}
                  </div>
                  <span
                    style={{
                      fontFamily: "monospace",
                      fontSize: 10,
                      color: O_DIM,
                      marginTop: 4,
                      paddingRight: 4,
                    }}
                  >
                    {step.time}
                  </span>
                </div>
              );
            }
            if (step.kind === "tool") {
              return (
                <div key={i} className="flex flex-col items-start">
                  <div
                    className="max-w-[95%] sm:max-w-[88%] px-4 py-3 text-sm leading-relaxed font-mono"
                    style={{
                      background: "rgba(0,0,0,0.35)",
                      border: "1px solid rgba(255,122,32,0.2)",
                      borderRadius: 2,
                      color: O,
                      fontSize: 12,
                    }}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span
                        style={{
                          display: "inline-block",
                          width: 6,
                          height: 6,
                          background: O,
                          boxShadow: O_GLOW,
                        }}
                      />
                      <span style={{ color: O_HI, textShadow: O_GLOW }}>
                        {step.label}
                      </span>
                      <span style={{ color: O_DIM }}>(</span>
                      <span style={{ color: O }}>{step.args}</span>
                      <span style={{ color: O_DIM }}>)</span>
                    </div>
                    <div
                      className="pl-3 border-l"
                      style={{
                        borderColor: "rgba(255,122,32,0.25)",
                        color: G,
                      }}
                    >
                      → {step.result}
                    </div>
                  </div>
                  <span
                    style={{
                      fontFamily: "monospace",
                      fontSize: 10,
                      color: O_DIM,
                      marginTop: 4,
                      paddingLeft: 4,
                    }}
                  >
                    {step.time}
                  </span>
                </div>
              );
            }
            // footer ribbon
            return (
              <div
                key={i}
                className="mt-1 flex items-center gap-2 px-3 py-2"
                style={{
                  background: "rgba(255,122,32,0.08)",
                  border: "1px solid rgba(255,122,32,0.35)",
                  borderRadius: 2,
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 6,
                    height: 6,
                    background: O,
                    boxShadow: O_GLOW,
                  }}
                />
                <span
                  className="text-xs font-mono"
                  style={{ color: O_HI, textShadow: O_GLOW }}
                >
                  {step.body}
                </span>
              </div>
            );
          })}

          {/* SSR-safe first frame: static intent line + cursor while we
              wait for IntersectionObserver to fire. Matches step 0's
              footprint so the swap is pure paint. */}
          {visible === 0 && (
            <div className="flex flex-col items-end opacity-80">
              <div
                className="px-4 py-3 text-sm leading-relaxed"
                style={{
                  background: "rgba(255,122,32,0.14)",
                  border: "1px solid rgba(255,122,32,0.45)",
                  borderRadius: 2,
                  color: O_HI,
                  fontFamily: "monospace",
                  fontSize: 13,
                }}
              >
                find me a hotel in Tokyo
                <span
                  style={{
                    color: O,
                    opacity: cursor ? 0.85 : 0.2,
                    transition: "opacity 60ms",
                    marginLeft: 2,
                  }}
                >
                  █
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
