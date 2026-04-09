"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";

const O      = "#FF7A20";
const O_DIM  = "rgba(255,122,32,0.40)";
const O_HI   = "#FFB060";
const O_GLOW = "0 0 8px rgba(255,122,32,0.75)";
const G      = "#4ADE80";
const BG     = "#060402";

interface Message {
  role: "user" | "agent";
  content: React.ReactNode;
  time: string;
}

const messages: Message[] = [
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
            <span className="uppercase tracking-widest text-[10px] font-medium" style={{ color: O_DIM }}>Executed</span>
            <span className="text-[10px] font-medium" style={{ color: G }}>200 OK · 0.4s</span>
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
          ✓ 243 listings found — $89–$420/night range
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

export function ChatDemo() {
  const [visibleCount, setVisibleCount] = useState(0);
  const [cursor, setCursor]             = useState(true);
  const containerRef                    = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          let count = 0;
          const interval = setInterval(() => {
            count++;
            setVisibleCount(count);
            if (count >= messages.length) clearInterval(interval);
          }, 500);
          observer.disconnect();
          return () => clearInterval(interval);
        }
      },
      { threshold: 0.2 }
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const iv = setInterval(() => setCursor((v) => !v), 520);
    return () => clearInterval(iv);
  }, []);

  const allDone = visibleCount >= messages.length;

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
              agent session  //  airbnb.com
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                background: allDone ? G : O,
                boxShadow: allDone ? "0 0 6px rgba(74,222,128,0.7)" : `0 0 6px ${O}`,
              }}
            />
            <span style={{ fontFamily: "monospace", fontSize: 10, color: allDone ? G : O_DIM, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              {allDone ? "complete" : "running"}
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
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex flex-col transition-all duration-500 ${
                i < visibleCount ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
              } ${msg.role === "user" ? "items-end" : "items-start"}`}
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

          {/* Typing indicator */}
          {visibleCount > 0 && visibleCount < messages.length && visibleCount % 2 === 1 && (
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
        </div>
      </div>
    </div>
  );
}
