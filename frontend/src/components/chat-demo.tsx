"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";

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
        <span className="block text-text-muted text-xs mb-1.5">Opening headless browser, navigating airbnb.com...</span>
        <span className="block text-text-muted text-xs mb-2">
          Captured 12 API endpoints across 4 services
        </span>
        <div className="space-y-1.5 mb-2.5">
          {[
            { method: "GET", path: "/api/v3/StaysSearch", label: "Search listings" },
            { method: "GET", path: "/api/v3/StayListing", label: "Listing details" },
            { method: "GET", path: "/api/v3/PdpAvailabilityCalendar", label: "Availability" },
            { method: "GET", path: "/api/v3/StaysPriceBreakdown", label: "Price breakdown" },
          ].map((ep) => (
            <div key={ep.path} className="flex items-center gap-2 text-xs font-mono">
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/15 text-emerald-400">
                {ep.method}
              </span>
              <span className="text-text-secondary">{ep.path}</span>
              <span className="text-text-muted">- {ep.label}</span>
            </div>
          ))}
          <span className="block text-text-muted text-[11px]">+ 8 more endpoints</span>
        </div>
        <span className="block text-emerald-400 text-xs font-medium">
          Skill generated: <strong>airbnb-stays-api</strong> (quality: 91/100)
        </span>
        <span className="block text-text-muted text-[11px] mt-1">
          Automatically indexed — every agent on the network can now use this
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
        <span className="block text-text-muted text-xs mb-1.5">
          Replaying <span className="text-orange-400">airbnb-stays-api</span> → GET /api/v3/StaysSearch
        </span>
        <div className="bg-black/30 rounded-lg p-3 font-mono text-xs text-text-secondary mt-1 leading-relaxed">
          <div className="text-text-muted">{"{"}</div>
          <div className="pl-4">&quot;results&quot;: <span className="text-emerald-400 font-bold">243</span> listings,</div>
          <div className="pl-4">&quot;topResult&quot;: {"{"}</div>
          <div className="pl-6">&quot;name&quot;: &quot;Shibuya Loft with City View&quot;,</div>
          <div className="pl-6">&quot;price&quot;: &quot;<span className="text-emerald-400 font-bold">$89</span>/night&quot;,</div>
          <div className="pl-6">&quot;rating&quot;: 4.92, &quot;reviews&quot;: 318</div>
          <div className="pl-4">{"}"}</div>
          <div className="text-text-muted">{"}"}</div>
        </div>
        <span className="block text-emerald-400 text-xs font-medium mt-2">
          243 listings found — $89-$420/night range
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
        <span className="block text-text-secondary text-xs leading-relaxed">
          Yes — the Airbnb skill is already in the shared index.
          Any agent can search for it by intent and replay the endpoints directly.
          No browser needed, no re-discovery.
        </span>
        <div className="mt-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-orange-500/8 border border-orange-500/15">
          <div className="w-1.5 h-1.5 rounded-full bg-orange-500" />
          <span className="text-xs font-mono text-orange-400">
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
  const containerRef = useRef<HTMLDivElement>(null);

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

  return (
    <div ref={containerRef} className="relative max-w-2xl mx-auto">
      <div className="absolute -inset-4 bg-gradient-radial from-orange-500/5 via-transparent to-transparent rounded-3xl blur-2xl" />

      <div className="relative bg-surface-raised border border-border rounded-2xl overflow-hidden shadow-2xl shadow-black/20">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-border bg-surface">
          <Image src="/logo.png" alt="unbrowse" width={28} height={28} className="rounded" />
          <div>
            <div className="text-sm font-semibold">Agent</div>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-[11px] text-text-muted">Online</span>
            </div>
          </div>
          <div className="ml-auto flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-border hover:bg-red-400/60 transition-colors" />
            <div className="w-3 h-3 rounded-full bg-border hover:bg-yellow-400/60 transition-colors" />
            <div className="w-3 h-3 rounded-full bg-border hover:bg-emerald-400/60 transition-colors" />
          </div>
        </div>

        {/* Messages */}
        <div className="p-5 space-y-4 min-h-[320px] sm:min-h-[420px] max-h-[560px] overflow-y-auto">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex flex-col transition-all duration-500 ${
                i < visibleCount ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
              } ${msg.role === "user" ? "items-end" : "items-start"}`}
            >
              <div
                className={`max-w-[95%] sm:max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-orange-500 text-white rounded-br-md"
                    : "bg-surface border border-border rounded-bl-md"
                }`}
              >
                {msg.content}
              </div>
              <span className="text-[10px] text-text-muted mt-1 px-1 font-mono">{msg.time}</span>
            </div>
          ))}

          {visibleCount > 0 && visibleCount < messages.length && visibleCount % 2 === 1 && (
            <div className="flex items-start opacity-60">
              <div className="bg-surface border border-border rounded-2xl rounded-bl-md px-4 py-3">
                <div className="flex gap-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: "0ms" }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: "150ms" }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Input (disabled) */}
        <div className="px-5 py-3 border-t border-border bg-surface">
          <div className="flex items-center gap-3 px-4 py-2.5 bg-surface-sunken rounded-xl">
            <span className="text-sm text-text-muted flex-1">Message your agent...</span>
            <svg className="w-4 h-4 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
