"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { searchSkills, executeSkill, type SearchResult } from "@/lib/api";

const O      = "#FF7A20";
const O_DIM  = "rgba(255,122,32,0.40)";
const O_HI   = "#FFB060";
const O_GLOW = "0 0 8px rgba(255,122,32,0.75)";
const G      = "#4ADE80";
const BG     = "#060402";

interface ChatMessage {
  role: "user" | "agent";
  content: React.ReactNode;
  time: string;
}

function getNow() {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
}

// ─── Static demo sequence (pre-written for the "watch" experience) ───

const demoSequence: ChatMessage[] = [
  {
    role: "user",
    content: "Unbrowse airbnb.com — I need to search listings",
    time: "2:41 PM",
  },
  {
    role: "agent",
    content: (
      <>
        <span className="block text-xs mb-1.5" style={{ color: O_DIM, fontFamily: "monospace", fontStyle: "italic" }}>
          Opening headless browser, navigating airbnb.com...
        </span>
        <span className="block text-xs mb-2 font-mono font-medium" style={{ color: G }}>
          ✓ Captured 12 API endpoints across 4 services
        </span>
        <div className="space-y-1.5 mb-2.5">
          {[
            { method: "GET", path: "/api/v3/StaysSearch", label: "Search listings" },
            { method: "GET", path: "/api/v3/StayListing", label: "Listing details" },
            { method: "GET", path: "/api/v3/PdpAvailabilityCalendar", label: "Availability" },
            { method: "GET", path: "/api/v3/StaysPriceBreakdown", label: "Price breakdown" },
          ].map((ep) => (
            <div key={ep.path} className="flex flex-wrap sm:flex-nowrap items-center gap-2 text-xs font-mono">
              <span
                className="px-1.5 py-0.5 text-[10px] font-medium shrink-0"
                style={{
                  background: "rgba(255,122,32,0.1)",
                  border: "1px solid rgba(255,122,32,0.35)",
                  color: O_HI,
                }}
              >
                {ep.method}
              </span>
              <span style={{ color: O }}>{ep.path}</span>
              <span style={{ color: O_DIM }}>— {ep.label}</span>
            </div>
          ))}
          <span className="block text-[11px] font-mono" style={{ color: O_DIM }}>+ 8 more endpoints</span>
        </div>
        <span className="block text-xs font-mono" style={{ color: O }}>
          Skill: <span style={{ color: O_HI, textShadow: "0 0 6px rgba(255,176,96,0.5)" }}>airbnb-stays-api</span>
          <span style={{ color: O_DIM }}> · quality: 91/100</span>
        </span>
        <span className="block text-[11px] font-mono mt-1" style={{ color: O_DIM }}>
          Indexed — every agent on the network can now use this
        </span>
      </>
    ),
    time: "2:42 PM",
  },
  {
    role: "user",
    content: "Find me places to stay in Tokyo for 2 guests, March 15-22",
    time: "2:43 PM",
  },
  {
    role: "agent",
    content: (
      <>
        <span className="block text-xs mb-1.5 font-mono" style={{ color: O_DIM, fontStyle: "italic" }}>
          Replaying <span style={{ color: O_HI }}>airbnb-stays-api</span> → GET /api/v3/StaysSearch
        </span>
        <div
          className="font-mono text-xs mt-1 leading-relaxed space-y-2 p-3"
          style={{
            background: "rgba(0,0,0,0.4)",
            border: "1px solid rgba(255,122,32,0.2)",
          }}
        >
          <div
            className="flex items-center justify-between pb-2 mb-1"
            style={{ borderBottom: "1px solid rgba(255,122,32,0.15)" }}
          >
            <span className="uppercase tracking-widest text-[10px] font-medium" style={{ color: O_DIM }}>Cached replay</span>
            <span className="text-[10px] font-medium" style={{ color: G }}>200 OK · 180ms</span>
          </div>
          {[
            { label: "listings found", value: "243 results" },
            { label: "top result",     value: "Shibuya Loft with City View" },
            { label: "price",          value: "$89/night" },
            { label: "rating",         value: "4.92 ★ (318 reviews)" },
          ].map(({ label, value }) => (
            <div key={label} className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 shrink-0" style={{ background: O, borderRadius: 0 }} />
              <span style={{ color: O_DIM }}>{label}:</span>
              <span className="font-medium" style={{ color: O }}>{value}</span>
            </div>
          ))}
        </div>
        <span className="block text-xs font-mono font-medium mt-2" style={{ color: G }}>
          ✓ 243 listings returned in ~5K tokens (vs ~114K via Playwright)
        </span>
      </>
    ),
    time: "2:43 PM",
  },
  {
    role: "user",
    content: "Can a different agent use this too?",
    time: "2:44 PM",
  },
  {
    role: "agent",
    content: (
      <>
        <span className="block text-xs leading-relaxed font-mono" style={{ color: O }}>
          Yes — the Airbnb skill is already in the shared index.
          Any agent can search for it by intent and replay the endpoints directly.
          No browser needed, no re-discovery.
        </span>
        <div
          className="mt-2 flex items-center gap-2 px-3 py-2"
          style={{
            background: "rgba(255,122,32,0.08)",
            border: "1px solid rgba(255,122,32,0.35)",
          }}
        >
          <div
            className="w-1.5 h-1.5 shrink-0"
            style={{ background: O, boxShadow: O_GLOW, borderRadius: 0 }}
          />
          <span className="text-xs font-mono font-medium" style={{ color: O_HI, textShadow: O_GLOW }}>
            One agent browses. Every agent knows.
          </span>
        </div>
      </>
    ),
    time: "2:44 PM",
  },
];

// ─── Render helpers for live mode ───

function renderEndpointBlock(endpoints: Array<{ method: string; url_template: string; verification_status: string }>) {
  return (
    <>
      <span className="block text-xs mb-1.5" style={{ color: O_DIM, fontFamily: "monospace", fontStyle: "italic" }}>
        Opening headless browser, navigating...
      </span>
      <span className="block text-xs mb-2 font-mono font-medium" style={{ color: G }}>
        ✓ Captured {endpoints.length} API endpoints
      </span>
      <div className="space-y-1.5 mb-2.5">
        {endpoints.slice(0, 5).map((ep, i) => (
          <div key={i} className="flex flex-wrap sm:flex-nowrap items-center gap-2 text-xs font-mono">
            <span
              className="px-1.5 py-0.5 text-[10px] font-medium shrink-0"
              style={{
                background: "rgba(255,122,32,0.1)",
                border: "1px solid rgba(255,122,32,0.35)",
                color: O_HI,
              }}
            >
              {ep.method}
            </span>
            <span style={{ color: O }}>{ep.url_template}</span>
            <span style={{ color: O_DIM }}>— {ep.verification_status}</span>
          </div>
        ))}
        {endpoints.length > 5 && (
          <span className="block text-[11px] font-mono" style={{ color: O_DIM }}>+ {endpoints.length - 5} more endpoints</span>
        )}
      </div>
      <span className="block text-xs font-mono" style={{ color: O }}>
        Skill: <span style={{ color: O_HI, textShadow: "0 0 6px rgba(255,176,96,0.5)" }}>detected skill</span>
        <span style={{ color: O_DIM }}> · processing</span>
      </span>
    </>
  );
}

function renderExecutionResult(skillName: string, method: string, path: string, data: SearchResult) {
  const meta = (data.metadata ?? {}) as Record<string, unknown> | undefined;
  const scoreDisplay = (data.score ?? 0).toFixed(4);
  return (
    <>
      <span className="block text-xs mb-1.5 font-mono" style={{ color: O_DIM, fontStyle: "italic" }}>
        Replaying <span style={{ color: O_HI }}>{skillName}</span> → {method} {path}
      </span>
      <div
        className="font-mono text-xs mt-1 leading-relaxed space-y-2 p-3"
        style={{
          background: "rgba(0,0,0,0.4)",
          border: "1px solid rgba(255,122,32,0.2)",
        }}
      >
        <div
          className="flex items-center justify-between pb-2 mb-1"
          style={{ borderBottom: "1px solid rgba(255,122,32,0.15)" }}
        >
          <span className="uppercase tracking-widest text-[10px] font-medium" style={{ color: O_DIM }}>Resolve Result</span>
          <span className="text-[10px] font-medium" style={{ color: G }}>{scoreDisplay} · matched</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 shrink-0" style={{ background: O, borderRadius: 0 }} />
          <span style={{ color: O_DIM }}>intent match:</span>
          <span className="font-medium" style={{ color: O }}>{String(meta?.name ?? meta?.intent_signature ?? "—")}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 shrink-0" style={{ background: O, borderRadius: 0 }} />
          <span style={{ color: O_DIM }}>domain:</span>
          <span className="font-medium" style={{ color: O }}>{String(meta?.domain ?? "—")}</span>
        </div>
        {data.metadata && typeof data.metadata === "object" && Object.keys(data.metadata).length > 0 && (
          <details className="text-[10px] font-mono" style={{ color: O_DIM }}>
            <summary style={{ cursor: "pointer" }}>view raw metadata</summary>
            <pre className="mt-1 overflow-x-auto text-[10px] leading-relaxed">{JSON.stringify(data.metadata, null, 2)}</pre>
          </details>
        )}
      </div>
      <span className="block text-xs font-mono font-medium mt-2" style={{ color: G }}>
        ✓ Match found — skill indexed on the shared registry
      </span>
    </>
  );
}

// ─── Main component ───

export function ChatDemo() {
  const [visibleCount, setVisibleCount] = useState(0);
  const [cursor, setCursor]             = useState(true);
  const [mode, setMode]                = useState<"demo" | "live">("demo");
  const [liveInput, setLiveInput]      = useState("");
  const [liveMessages, setLiveMessages] = useState<ChatMessage[]>([]);
  const [liveLoading, setLiveLoading]  = useState(false);
  const [liveError, setLiveError]      = useState<string | null>(null);
  const [activeSearch, setActiveSearch] = useState<SearchResult[]>([]);
  const [activeResult, setActiveResult] = useState<SearchResult | null>(null);
  const [demoFinished, setDemoFinished] = useState(false);
  const containerRef                    = useRef<HTMLDivElement>(null);
  const inputRef                        = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleCount, liveMessages]);

  // Cursor blink
  useEffect(() => {
    const iv = setInterval(() => setCursor((v) => !v), 520);
    return () => clearInterval(iv);
  }, []);

  // Demo mode: animate sequence
  useEffect(() => {
    if (mode !== "demo") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          let count = 0;
          const interval = setInterval(() => {
            count++;
            setVisibleCount(count);
            if (count >= demoSequence.length) {
              clearInterval(interval);
              setDemoFinished(true);
            }
          }, 500);
          observer.disconnect();
          return () => clearInterval(interval);
        }
      },
      { threshold: 0.2 }
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [mode]);

  // Live mode: search on user input
  async function handleLiveSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!liveInput.trim() || liveLoading) return;

    setLiveLoading(true);
    setLiveError(null);

    const userMsg: ChatMessage = {
      role: "user",
      content: liveInput.trim(),
      time: getNow(),
    };

    setLiveMessages((prev) => [...prev, userMsg]);
    setActiveSearch([]);
    setActiveResult(null);

    try {
      const results = await searchSkills(liveInput.trim());
      setActiveSearch(results);

      if (results.length === 0) {
        setLiveMessages((prev) => [
          ...prev,
          {
            role: "agent",
            content: (
              <span style={{ color: O_DIM, fontFamily: "monospace", fontSize: "12px" }}>
                No matching skills found for "{liveInput.trim()}".
              </span>
            ),
            time: getNow(),
          },
        ]);
        setLiveLoading(false);
        return;
      }

      // Show "discovering" message with endpoints
      const best = results[0];
      const meta = best.metadata as Record<string, unknown> | undefined;
      const skillName = String(meta?.name ?? meta?.intent_signature ?? "unknown");

      setLiveMessages((prev) => [
        ...prev,
        {
          role: "agent",
          content: renderEndpointBlock([
            { method: "POST", url_template: "/v1/skills/search", verification_status: "resolved" },
            ...((meta?.endpoints as Array<{ method: string; url_template: string; verification_status: string }> | undefined) ?? []),
          ]),
          time: getNow(),
        },
      ]);

      // Show the execution result
      await new Promise((r) => setTimeout(r, 800));
      setActiveResult(best);
      setLiveMessages((prev) => [
        ...prev,
        {
          role: "agent",
          content: renderExecutionResult(skillName, String(best.metadata?.method ?? "GET"), String(best.metadata?.domain ?? "web"), best),
          time: getNow(),
        },
      ]);
    } catch (err) {
      setLiveError((err as Error).message);
      setLiveMessages((prev) => [
        ...prev,
        {
          role: "agent",
          content: (
            <span style={{ color: "#F87171", fontFamily: "monospace", fontSize: "12px" }}>
              Error: {(err as Error).message}
            </span>
          ),
          time: getNow(),
        },
      ]);
    }

    setLiveLoading(false);
    setLiveInput("");
  }

  // Reset demo when switching back to demo mode
  useEffect(() => {
    if (mode === "demo") {
      setVisibleCount(0);
      setDemoFinished(false);
    }
  }, [mode]);

  // ─── Live mode: search results panel ───
  function renderSearchResultsPanel() {
    if (activeSearch.length === 0) return null;
    return (
      <div
        className="mt-2 space-y-1"
        style={{
          background: "rgba(255,122,32,0.06)",
          border: "1px solid rgba(255,122,32,0.25)",
          borderRadius: "2px",
          padding: "8px 10px",
          maxHeight: "120px",
          overflowY: "auto",
        }}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-wider font-mono" style={{ color: O_DIM }}>
            {activeSearch.length} results
          </span>
        </div>
        {activeSearch.slice(0, 3).map((r, i) => {
          const meta = r.metadata as Record<string, unknown> | undefined;
          const name = String(meta?.name ?? meta?.intent_signature ?? `Result ${i + 1}`);
          const domain = String(meta?.domain ?? "—");
          const score = (r.score ?? 0).toFixed(4);
          return (
            <div
              key={i}
              className="flex items-center justify-between text-[11px] font-mono cursor-pointer hover:bg-white/5 px-1 rounded"
              onClick={() => setActiveResult(r)}
            >
              <span style={{ color: O }}>{name}</span>
              <span style={{ color: O_DIM }}>{domain}</span>
              <span style={{ color: G }}>{score}</span>
            </div>
          );
        })}
        {activeSearch.length > 3 && (
          <div className="text-[10px] font-mono" style={{ color: O_DIM, textAlign: "center", marginTop: "4px" }}>
            + {activeSearch.length - 3} more
          </div>
        )}
      </div>
    );
  }

  const allDone = mode === "demo" ? visibleCount >= demoSequence.length : liveMessages.length > 0;
  const allMessages = mode === "demo" ? demoSequence : liveMessages;
  const messagesToRender = mode === "demo"
    ? allMessages.slice(0, visibleCount)
    : allMessages;

  return (
    <div ref={containerRef} className="relative max-w-2xl mx-auto">
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

        {/* Title bar */}
        <div
          style={{
            borderBottom: "1px solid rgba(255,122,32,0.22)",
            padding: "7px 12px",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            background: "rgba(0,0,0,0.35)",
            position: "relative", zIndex: 30,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Image src="/logo.png" alt="unbrowse" width={18} height={18} unoptimized style={{ borderRadius: 2, opacity: 0.8 }} />
            <span style={{ fontFamily: "monospace", fontSize: 10, color: O_DIM, letterSpacing: "0.18em", textTransform: "uppercase" }}>
              {mode === "demo" ? "agent session  //  airbnb.com" : "agent session  //  live mode"}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              onClick={() => setMode(mode === "demo" ? "live" : "demo")}
              style={{
                fontFamily: "monospace",
                fontSize: 9,
                color: mode === "live" ? G : O_DIM,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                background: "none",
                border: "none",
                cursor: "pointer",
              }}
            >
              [{mode === "live" ? "●" : "○"} {mode}]
            </button>
            <span
              style={{
                display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                background: allDone && mode === "demo" ? G : O,
                boxShadow: allDone && mode === "demo" ? "0 0 6px rgba(74,222,128,0.7)" : `0 0 6px ${O}`,
              }}
            />
            <span style={{ fontFamily: "monospace", fontSize: 10, color: (allDone && mode === "demo") ? G : O_DIM, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              {mode === "demo" ? (allDone ? "complete" : "running") : (liveLoading ? "resolving..." : "waiting")}
            </span>
          </div>
        </div>

        {/* Messages */}
        <div
          style={{
            padding: "16px",
            minHeight: "200px",
            maxHeight: "360px",
            overflowY: "auto",
            position: "relative",
            zIndex: 30,
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          {messagesToRender.map((msg, i) => (
            <div
              key={i}
              className={`flex flex-col transition-all duration-500 ${
                msg.role === "user" ? "items-end" : "items-start"
              }`}
            >
              <div
                className="max-w-[95%] sm:max-w-[88%] px-4 py-3 text-sm leading-relaxed"
                style={
                  msg.role === "user"
                    ? {
                        background: "rgba(255,122,32,0.14)",
                        border: "1px solid rgba(255,122,32,0.45)",
                        borderRadius: "2px",
                        color: O_HI,
                        fontFamily: "monospace",
                        fontSize: "13px",
                        textShadow: "0 0 6px rgba(255,176,96,0.3)",
                      }
                    : {
                        background: "rgba(0,0,0,0.35)",
                        border: "1px solid rgba(255,122,32,0.2)",
                        borderRadius: "2px",
                        color: O,
                      }
                }
              >
                {msg.content}
              </div>
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: "10px",
                  color: O_DIM,
                  marginTop: "4px",
                  paddingLeft: msg.role === "user" ? 0 : "4px",
                  paddingRight: msg.role === "user" ? "4px" : 0,
                }}
              >
                {msg.time}
              </span>
            </div>
          ))}

          {/* Search results panel (live mode) */}
          {mode === "live" && !liveLoading && activeSearch.length > 0 && activeResult && (
            <div className="items-start">
              {renderSearchResultsPanel()}
            </div>
          )}

          {/* Typing indicator */}
          {liveLoading && mode === "live" && (
            <div className="flex items-start opacity-70">
              <div
                className="px-4 py-3"
                style={{
                  background: "rgba(0,0,0,0.35)",
                  border: "1px solid rgba(255,122,32,0.2)",
                  borderRadius: "2px",
                }}
              >
                <div className="flex gap-1.5">
                  {[0, 150, 300].map((delay) => (
                    <div
                      key={delay}
                      className="w-1.5 h-1.5 animate-bounce"
                      style={{ background: O, borderRadius: 0, animationDelay: `${delay}ms` }}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Demo typing indicator */}
          {mode === "demo" && visibleCount > 0 && visibleCount < demoSequence.length && visibleCount % 2 === 1 && (
            <div className="flex items-start opacity-70">
              <div
                className="px-4 py-3"
                style={{
                  background: "rgba(0,0,0,0.35)",
                  border: "1px solid rgba(255,122,32,0.2)",
                  borderRadius: "2px",
                }}
              >
                <div className="flex gap-1.5">
                  {[0, 150, 300].map((delay) => (
                    <div
                      key={delay}
                      className="w-1.5 h-1.5 animate-bounce"
                      style={{ background: O, borderRadius: 0, animationDelay: `${delay}ms` }}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Input bar */}
        <div
          style={{
            borderTop: "1px solid rgba(255,122,32,0.18)",
            background: "rgba(0,0,0,0.35)",
            padding: "8px 12px",
            position: "relative",
            zIndex: 30,
          }}
        >
          {mode === "demo" ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "6px 12px",
                background: "rgba(0,0,0,0.4)",
                border: "1px solid rgba(255,122,32,0.18)",
              }}
            >
              <span style={{ fontFamily: "monospace", fontSize: "12px", color: O_DIM }}>▸</span>
              <span style={{ fontFamily: "monospace", fontSize: "12px", color: O_DIM, flex: 1 }}>
                Message your agent...
              </span>
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: "12px",
                  color: O,
                  opacity: cursor ? 0.7 : 0.2,
                  transition: "opacity 60ms",
                }}
              >
                █
              </span>
            </div>
          ) : (
            <form onSubmit={handleLiveSubmit}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 12px",
                  background: "rgba(0,0,0,0.4)",
                  border: "1px solid rgba(255,122,32,0.25)",
                }}
              >
                <span style={{ fontFamily: "monospace", fontSize: "12px", color: G }}>▸</span>
                <input
                  ref={inputRef}
                  type="text"
                  value={liveInput}
                  onChange={(e) => setLiveInput(e.target.value)}
                  disabled={liveLoading}
                  placeholder="Search any domain by intent..."
                  style={{
                    fontFamily: "monospace",
                    fontSize: "12px",
                    color: O_HI,
                    flex: 1,
                    background: "none",
                    border: "none",
                    outline: "none",
                  }}
                  className="placeholder:text-text-muted"
                />
                <button
                  type="submit"
                  disabled={liveLoading || !liveInput.trim()}
                  style={{
                    fontFamily: "monospace",
                    fontSize: "12px",
                    color: liveLoading || !liveInput.trim() ? O_DIM : G,
                    background: "none",
                    border: "none",
                    cursor: liveLoading || !liveInput.trim() ? "default" : "pointer",
                  }}
                >
                  {liveLoading ? "⟳" : "↵"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
