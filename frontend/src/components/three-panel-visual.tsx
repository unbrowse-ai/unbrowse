"use client";

import { useEffect, useState, useRef } from "react";
import { Globe2, Search, MousePointer2 } from "lucide-react";
import {
  IconFrame,
  IconTerminal,
  IconHourglass,
  IconArrow,
  IconDiamondCheck,
  IconCode,
  IconCycle,
  IconAperture,
  IconSpinner,
  IconSigil,
} from "@/components/archival-icons";

export function ThreePanelVisual() {
  const [time, setTime] = useState(0);
  const [isFinished, setIsFinished] = useState(false);
  const startRef = useRef<number>(0);
  const frameRef = useRef<number>(0);
  const sectionRef = useRef<HTMLElement>(null);
  const hasPlayedRef = useRef(false);

  const playAnimation = () => {
    setIsFinished(false);
    setTime(0);
    startRef.current = Date.now();
    
    const tick = () => {
      let elapsed = Date.now() - startRef.current;
      if (elapsed >= 9000) {
        setTime(9000);
        setIsFinished(true);
        return; // stop requesting frames
      }
      setTime(elapsed);
      frameRef.current = requestAnimationFrame(tick);
    };
    
    frameRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !hasPlayedRef.current) {
          hasPlayedRef.current = true;
          playAnimation();
        }
      },
      { threshold: 0.2 }
    );

    if (sectionRef.current) {
      observer.observe(sectionRef.current);
    }

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameRef.current);
    };
  }, []);

  const handleReplay = () => {
    cancelAnimationFrame(frameRef.current);
    playAnimation();
  };

  // Format times
  const browserTime = Math.min(time / 1000, 8.4).toFixed(1) + "s";
  
  // Stretch the API animation out a bit so it's readable, but end the timer at 0.4s for effect.
  const unbrowseTimeMs = Math.min(time, 800);
  const unbrowseTime = (unbrowseTimeMs / 1000).toFixed(2) + "s";

  // Context & Cost Calculations
  let browserPasses = 1;
  if (time > 2000) browserPasses = 2; // initial click/type
  if (time > 5500) browserPasses = 3; // scroll action
  if (time > 6500) browserPasses = 4; // final listing click

  const browserTokens = browserPasses * 128500;
  const browserCost = (browserTokens * 0.000003).toFixed(3);

  let apiTokens = 0;
  let apiPasses = 0;
  if (time > 0) { apiTokens += 350; apiPasses++; }
  if (time > 200) { apiTokens += 200; apiPasses++; }
  if (time > 400) { apiTokens += 250; apiPasses++; }
  if (time > 600) { apiTokens += 200; apiPasses++; }

  const apiCost = (apiTokens * 0.000003).toFixed(4);

  // Cursor animation positions based on time
  let cursorX = 50;
  let cursorY = 200;
  let cursorOpacity = 0;
  let cursorScale = 1;
  let clickEffect = false;
  
  let uiScrollY = 0;
  let domScrollY = 0;

  if (time > 500) cursorOpacity = 1;
  
  if (time >= 500 && time < 2000) {
    const t = (time - 500) / 1500;
    const ease = 1 - Math.pow(1 - t, 3);
    cursorX = 50 + (160 - 50) * ease;
    cursorY = 200 + (70 - 200) * ease;
  } else if (time >= 2000 && time < 4000) {
    cursorX = 160; cursorY = 70;
    if (time >= 2000 && time < 2200) {
      cursorScale = 0.8;
      clickEffect = time < 2100;
    }
  } else if (time >= 4000 && time < 5500) {
    const t = (time - 4000) / 1500;
    const ease = 1 - Math.pow(1 - t, 3);
    cursorX = 160 + (80 - 160) * ease;
    cursorY = 70 + (180 - 70) * ease;
  } else if (time >= 5500 && time < 6500) {
    cursorX = 80; cursorY = 180;
    const t = (time - 5500) / 1000;
    const ease = 1 - Math.pow(1 - t, 3);
    uiScrollY = -40 * ease;
  } else if (time >= 6500) {
    cursorX = 80; cursorY = 180;
    uiScrollY = -40;
    if (time >= 6500 && time < 6700) {
      cursorScale = 0.8;
      clickEffect = time < 6600;
    }
  }
  
  // DOM Scroll
  if (time > 1000) {
    const t = Math.min((time - 1000) / 7000, 1);
    domScrollY = -250 * t;
  }

  // Screenshot Flash effect calculation
  const getFlashOpacity = (t: number, start: number) => {
    if (t < start || t > start + 300) return 0;
    if (t < start + 50) return (t - start) / 50; // ramp up
    return 1 - ((t - (start + 50)) / 250); // fade out
  };

  const flash1 = getFlashOpacity(time, 400);
  const flash2 = getFlashOpacity(time, 1900);
  const flash3 = getFlashOpacity(time, 5400);
  const flash4 = getFlashOpacity(time, 6400);
  const currentFlash = Math.max(flash1, flash2, flash3, flash4);

  const toolCalls = [
    { tool: "unbrowse.search", args: "{ query: 'Tokyo' }", result: "182 listings found", ms: "110ms", startAt: 0, endAt: 200 },
    { tool: "unbrowse.check_availability", args: "{ id: 'TKY-882' }", result: "Mar 15-22 available", ms: "90ms", startAt: 200, endAt: 400 },
    { tool: "unbrowse.get_reviews", args: "{ id: 'TKY-882' }", result: "48 reviews, avg 4.9★", ms: "80ms", startAt: 400, endAt: 600 },
    { tool: "unbrowse.book", args: "{ id: 'TKY-882' }", result: "Booking #TKY-8821 confirmed", ms: "120ms", startAt: 600, endAt: 800 },
  ];

    return (
      <section ref={sectionRef} className="relative min-h-[100dvh] flex flex-col justify-center overflow-hidden py-8">
        <div className="relative max-w-[90rem] mx-auto px-4 sm:px-6">
            <div className="text-center mb-12 sm:mb-16 relative">
              <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-4">
                ##  The Problem
              </p>
              <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold tracking-tight mt-3 mb-4 text-balance text-text-primary">
                Three ways to see the same website
              </h2>
              
              <div className="absolute right-0 top-0 hidden md:block">
                <button
                  onClick={handleReplay}
                  className={`flex items-center gap-2 px-4 py-2 border border-[rgba(255,122,32,0.3)] bg-[#060402] text-[rgba(255,122,32,0.7)] hover:text-[rgba(255,176,96,0.9)] hover:border-[rgba(255,122,32,0.5)] transition-all font-mono text-xs ${isFinished ? 'opacity-100 scale-100' : 'opacity-0 scale-95 pointer-events-none'}`}
                >
                  <IconCycle size={14} />
                  Replay
                </button>
              </div>
            </div>

            <div className="flex flex-col lg:grid lg:grid-cols-3 gap-6">
              
              {/* Shared Timer for Panels 1 & 2 */}
              <div className="lg:col-span-2 relative rounded-sm p-4 sm:p-6 bg-[#060402] border border-[rgba(255,122,32,0.28)] mt-5">
                {/* Timer badge — full width on mobile, centered pill on desktop */}
                <div className="absolute -top-4 left-4 right-4 lg:left-1/2 lg:right-auto lg:-translate-x-1/2 z-50 bg-[#060402] text-[rgba(255,250,242,0.95)] text-[10px] sm:text-xs font-mono px-3 sm:px-4 py-2 border border-[rgba(255,122,32,0.4)] flex items-center justify-center gap-2 sm:gap-4 shadow-xl shadow-[rgba(0,0,0,0.2)]" style={{ boxShadow: '0 0 20px rgba(255,82,0,0.1)' }}>
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse shrink-0" />
                    <span className="text-zinc-400 hidden xs:inline">Time:</span>
                    <span className="text-orange-400 font-bold tabular-nums">{browserTime}</span>
                  </div>
                  <div className="w-px h-3 bg-white/20 shrink-0" />
                  <div className="flex items-center gap-1.5">
                    <span className="text-zinc-400 hidden xs:inline">Tokens:</span>
                    <span className="text-red-400 font-bold tabular-nums">{browserTokens.toLocaleString()}</span>
                  </div>
                  <div className="w-px h-3 bg-white/20 shrink-0" />
                  <div className="flex items-center gap-1.5">
                    <span className="text-zinc-400 hidden xs:inline">Cost:</span>
                    <span className="text-red-400 font-bold tabular-nums">${browserCost}</span>
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-4 sm:gap-6 mt-2">

              {/* What Humans See */}
            <div className="group rounded-sm border border-[rgba(255,122,32,0.22)] bg-[#060402] overflow-hidden transition-all relative">
              <div className="px-4 py-3 border-b border-[rgba(255,122,32,0.18)] bg-[rgba(0,0,0,0.4)] flex items-center gap-3">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-border-strong" />
                  <div className="w-2.5 h-2.5 rounded-full bg-border-strong" />
                  <div className="w-2.5 h-2.5 rounded-full bg-border-strong" />
                </div>
                <div className="flex-1 flex justify-center">
                  <div className="px-3 py-1 rounded-sm bg-[#060402] border border-[rgba(255,122,32,0.2)] text-[10px] sm:text-xs text-[rgba(255,122,32,0.55)] font-mono flex items-center gap-2">
                    travelbooker.com
                  </div>
                </div>
              </div>
                <div className="p-4 bg-white text-zinc-800 text-[10px] relative h-[320px] overflow-hidden">
                  
                  {/* Screenshot Flash Effect */}
                  {currentFlash > 0 && (
                    <div 
                      className="absolute inset-0 z-[60] bg-white pointer-events-none flex items-center justify-center"
                      style={{ opacity: currentFlash * 0.9 }}
                    >
                      <div className="bg-[#0a0705]/95 text-[rgba(255,250,242,0.95)] px-3 py-1.5 rounded-full flex items-center gap-2 text-xs font-mono shadow-xl">
                        <IconAperture size={14} />
                        <span>Screenshot captured</span>
                      </div>
                    </div>
                  )}

                  {/* Animated Cursor */}
                <div 
                  className="absolute z-50 pointer-events-none"
                  style={{ 
                    transform: `translate(${cursorX}px, ${cursorY}px) scale(${cursorScale})`,
                    opacity: cursorOpacity
                  }}
                >
                  <MousePointer2 className="w-5 h-5 text-zinc-900 drop-shadow-md fill-white" />
                  {clickEffect && (
                    <div className="absolute top-1 left-1 w-4 h-4 bg-zinc-900/30 rounded-full animate-ping" />
                  )}
                </div>

                <div style={{ transform: `translateY(${uiScrollY}px)` }}>
                  {/* Mock website UI */}
                  <div className="flex items-center justify-between pb-2">
                    <div className="font-bold text-rose-500 text-[14px] flex items-center gap-1.5 tracking-tight">
                      <Globe2 className="w-4 h-4" /> travelbooker
                    </div>
                    <div className="hidden sm:flex gap-4 font-medium text-zinc-500 text-[10px]">
                      <span className="text-zinc-900">Stays</span>
                      <span>Experiences</span>
                    </div>
                    <div className="w-6 h-6 rounded-full bg-zinc-100 border border-zinc-200 flex items-center justify-center overflow-hidden">
                      <div className="w-3 h-3 bg-zinc-300 rounded-full mt-2" />
                    </div>
                  </div>
                  
                  {/* Search Bar */}
                  <div className="w-full bg-white rounded-full pl-4 pr-1.5 py-1.5 shadow-[0_4px_12px_rgba(0,0,0,0.06)] border border-zinc-200 flex items-center justify-between mx-auto max-w-sm mb-3">
                    <div className="flex flex-col">
                      <span className="text-[10px] font-bold text-zinc-800">
                        {time < 2200 ? "Anywhere" : time < 2400 ? "T|" : time < 2600 ? "Tok|" : time < 2800 ? "Toky|" : "Tokyo"}
                      </span>
                      <span className="text-[9px] text-zinc-400">Any week • Add guests</span>
                    </div>
                    <div className="bg-rose-500 text-white p-2 rounded-full">
                      <Search className="w-3.5 h-3.5" />
                    </div>
                  </div>
                  
                  {/* Grid Cards */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="group">
                      <div className="rounded-xl overflow-hidden mb-2 relative aspect-[4/3] bg-zinc-100">
                        <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?auto=format&fit=crop&w=400&q=80')] bg-cover bg-center" />
                      </div>
                      <div className="flex justify-between items-start leading-tight">
                        <div className="font-semibold text-zinc-900 text-[11px]">Tokyo, Japan</div>
                        <div className="flex items-center gap-0.5 text-[10px]">★ 4.98</div>
                      </div>
                      <div className="text-zinc-500 text-[10px]">Oct 15 - 22</div>
                      <div className="text-zinc-900 text-[11px] mt-1"><span className="font-semibold">$89</span> night</div>
                    </div>

                    <div className="group">
                      <div className="rounded-xl overflow-hidden mb-2 relative aspect-[4/3] bg-zinc-100">
                        <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1499856871958-5b9627545d1a?auto=format&fit=crop&w=400&q=80')] bg-cover bg-center" />
                      </div>
                      <div className="flex justify-between items-start leading-tight">
                        <div className="font-semibold text-zinc-900 text-[11px]">Paris, France</div>
                        <div className="flex items-center gap-0.5 text-[10px]">★ 4.92</div>
                      </div>
                      <div className="text-zinc-500 text-[10px]">Nov 2 - 7</div>
                      <div className="text-zinc-900 text-[11px] mt-1"><span className="font-semibold">$112</span> night</div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="px-4 py-3 border-t border-[rgba(255,122,32,0.18)] bg-[rgba(0,0,0,0.4)] text-center relative z-20">
                <h4 className="text-[13px] font-mono text-[rgba(255,122,32,0.8)] flex items-center justify-center gap-2">
                  <IconFrame size={14} className="text-[rgba(255,122,32,0.5)]" /> What Humans See
                </h4>
                <p className="text-[11px] text-[rgba(255,122,32,0.4)] mt-0.5 font-mono">Beautiful, interactive UI</p>
              </div>
            </div>

              {/* What Agents See Today */}
              <div className="group rounded-sm border border-[rgba(255,122,32,0.22)] bg-[#060402] overflow-hidden transition-all relative">
              <div className="px-4 py-3 border-b border-[rgba(255,122,32,0.18)] bg-[rgba(0,0,0,0.4)] flex items-center gap-3 relative z-20">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-[rgba(255,122,32,0.3)]" />
                  <div className="w-2.5 h-2.5 rounded-full bg-[rgba(255,122,32,0.3)]" />
                  <div className="w-2.5 h-2.5 rounded-full bg-[rgba(255,122,32,0.3)]" />
                </div>
                <div className="flex-1 flex justify-center">
                  <div className="px-3 py-1 rounded-sm bg-[#060402] border border-[rgba(255,122,32,0.2)] text-[10px] sm:text-xs text-[rgba(255,122,32,0.55)] font-mono flex items-center gap-2">
                    view-source:travelbooker.com
                  </div>
                </div>
              </div>
              <div className="p-4 font-mono text-[10px] sm:text-[11px] leading-[1.7] text-text-muted overflow-hidden h-[320px] relative bg-zinc-950">
                <div 
                  className="select-none relative z-10 text-zinc-500 break-all"
                  style={{ transform: `translateY(${domScrollY}px)` }}
                >
                  <span className="text-blue-400">&lt;!DOCTYPE html&gt;</span><span className="text-zinc-300">&lt;html lang="en"&gt;&lt;head&gt;&lt;meta charset="utf-8"/&gt;&lt;meta name="viewport" content="width=device-width"/&gt;&lt;script&gt;var _0x3f2a=function(_0x2b1c)&#123;var _0x4e3d=_0x2b1c.split("").reverse().join("");return atob(_0x4e3d)&#125;;window.__CF=&#123;&#125;;(function()&#123;var a="x3f",b=document.createElement("div");b.className="x3f"+a;b.id="_0x"+Math.random().toString(36).substr(2,9);&lt;/script&gt;&lt;link rel="stylesheet" href="/_next/static/css/a3b2c1d.css"/&gt;&lt;style&gt;.x3f&#123;display:flex;flex-direction:column&#125;.x3f&gt;div&#123;padding:0&#125;.x3f .k9m&#123;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)&#125;.x3f .q7p&#123;position:absolute;top:0;left:0;right:0;bottom:0;z-index:1&#125;.x3f .r2w&#123;font-size:clamp(1.5rem,4vw,3rem);font-weight:800;letter-spacing:-.02em;line-height:1.1&#125;&lt;/style&gt;&lt;/head&gt;&lt;body&gt;&lt;div id="__next"&gt;&lt;div class="x3f"&gt;&lt;div class="x3f q7p"&gt;&lt;nav class="x3f k9m"&gt;&lt;div class="x3f"&gt;&lt;a href="/" class="x3f r2w"&gt;TravelBooker&lt;/a&gt;&lt;div class="x3f"&gt;&lt;a href="/flights" class="x3f"&gt;Flights&lt;/a&gt;&lt;a href="/hotels" class="x3f"&gt;Hotels&lt;/a&gt;&lt;/div&gt;&lt;/div&gt;&lt;/nav&gt;&lt;main class="x3f"&gt;&lt;div class="x3f k9m"&gt;&lt;h1 class="x3f r2w"&gt;Find your perfect getaway&lt;/h1&gt;&lt;form class="x3f" action="/search" method="GET"&gt;&lt;input class="x3f" name="q" placeholder="Anywhere" value=""/&gt;&lt;button type="submit" class="x3f"&gt;Search&lt;/button&gt;&lt;/form&gt;&lt;/div&gt;&lt;div class="x3f"&gt;&lt;div class="x3f"&gt;&lt;div class="x3f"&gt;&lt;img src="https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?auto=format&fit=crop&w=400&q=80" alt="Tokyo, Japan" class="x3f"/&gt;&lt;/div&gt;&lt;div class="x3f"&gt;&lt;div class="x3f"&gt;Tokyo, Japan&lt;/div&gt;&lt;div class="x3f"&gt;★ 4.98&lt;/div&gt;&lt;/div&gt;&lt;div class="x3f"&gt;2,410 kilometers away&lt;/div&gt;&lt;div class="x3f"&gt;Oct 15 - 22&lt;/div&gt;&lt;div class="x3f"&gt;&lt;span class="x3f"&gt;$89&lt;/span&gt; night&lt;/div&gt;&lt;/div&gt;&lt;div class="x3f"&gt;&lt;div class="x3f"&gt;&lt;img src="https://images.unsplash.com/photo-1499856871958-5b9627545d1a?auto=format&fit=crop&w=400&q=80" alt="Paris, France" class="x3f"/&gt;&lt;/div&gt;&lt;div class="x3f"&gt;&lt;div class="x3f"&gt;Paris, France&lt;/div&gt;&lt;div class="x3f"&gt;★ 4.92&lt;/div&gt;&lt;/div&gt;&lt;div class="x3f"&gt;View of Eiffel Tower&lt;/div&gt;</span>
                </div>
                <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-zinc-950 via-zinc-950/80 to-transparent z-20 pointer-events-none" />
              </div>
                <div className="px-4 py-3 border-t border-[rgba(255,122,32,0.18)] bg-[rgba(0,0,0,0.4)] text-center relative z-30">
                  <h4 className="text-[13px] font-mono text-[rgba(255,122,32,0.8)] flex items-center justify-center gap-2">
                    <IconTerminal size={14} className="text-[rgba(255,122,32,0.5)]" /> What Agents See Today
                  </h4>
                  <p className="text-[11px] text-[rgba(255,122,32,0.4)] mt-0.5 font-mono">Image + 847KB DOM <span className="text-red-400 font-medium">× {browserPasses} passes</span></p>
                </div>
              </div>
            </div>{/* end grid sm:grid-cols-2 */}
          </div>{/* end lg:col-span-2 */}

              {/* What Unbrowse Does */}
              <div className="relative mt-5 lg:mt-0 flex flex-col">
                <div className="absolute -top-4 left-4 right-4 lg:left-1/2 lg:right-auto lg:-translate-x-1/2 z-50 bg-orange-500 text-white text-[10px] sm:text-xs font-mono px-3 sm:px-4 py-2 flex items-center justify-center gap-2 sm:gap-3 shadow-xl shadow-orange-500/20">
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse shrink-0" />
                    <span className="hidden sm:inline text-orange-200">Time:</span>
                    <span className="font-bold tabular-nums">{unbrowseTime}</span>
                  </div>
                  <div className="w-px h-3 bg-white/20 shrink-0" />
                  <div className="flex items-center gap-1.5">
                    <span className="hidden sm:inline text-orange-200">Tokens:</span>
                    <span className="font-bold tabular-nums">{apiTokens.toLocaleString()}</span>
                  </div>
                  <div className="w-px h-3 bg-white/20 shrink-0" />
                  <div className="flex items-center gap-1.5">
                    <span className="hidden sm:inline text-orange-200">Cost:</span>
                    <span className="font-bold tabular-nums">${apiCost}</span>
                  </div>
                </div>

            <div className="flex-1 rounded-sm border border-[rgba(255,122,32,0.5)] bg-[#060402] overflow-hidden transition-all shadow-[0_0_40px_-10px_rgba(255,109,0,0.25)] hover:shadow-[0_0_60px_-15px_rgba(255,109,0,0.4)] hover:border-[rgba(255,122,32,0.7)] z-10 relative flex flex-col pt-3">
              <div className="px-5 py-4 border-b border-[rgba(255,122,32,0.18)] bg-[rgba(0,0,0,0.4)] flex items-center gap-3">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-orange-500/20" />
                  <div className="w-2.5 h-2.5 rounded-full bg-orange-500/20" />
                  <div className="w-2.5 h-2.5 rounded-full bg-orange-500/20" />
                </div>
                <div className="flex-1 flex justify-center">
                  <div className="px-3 py-1 rounded-sm bg-[#060402] border border-[rgba(255,122,32,0.35)] text-[10px] sm:text-xs text-[rgba(255,176,96,0.9)] font-mono flex items-center gap-2 font-medium" style={{ textShadow: '0 0 8px rgba(255,176,96,0.5)' }}>
                    agent_session <IconArrow size={12} className="text-orange-400" /> API
                  </div>
                </div>
              </div>

              <div className="p-5 flex-1 flex flex-col justify-start bg-zinc-950 font-mono text-xs relative overflow-hidden space-y-3">
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-orange-500/10 via-transparent to-transparent pointer-events-none" />
                
                {toolCalls.map((call, i) => {
                  const isActive = time >= call.startAt && time < call.endAt;
                  const isComplete = time >= call.endAt;
                  const isPending = time < call.startAt;

                  if (isPending) return null;

                  return (
                    <div key={i} className="relative z-10 animate-fade-up">
                      {/* Tool Call Initiation */}
                      <div className="flex items-start gap-2 mb-1.5 text-zinc-300">
                        <IconCode size={16} className="text-orange-400 shrink-0 mt-0.5" />
                        <div className="flex flex-col">
                          <span className="text-orange-400 font-semibold">{call.tool}</span>
                          <span className="text-zinc-500 text-[10px]">{call.args}</span>
                        </div>
                      </div>

                      {/* Result */}
                      <div className="flex items-center gap-2 pl-6">
                        {isActive ? (
                          <>
                            <IconSpinner size={14} className="text-zinc-500 animate-spin" />
                            <span className="text-zinc-500 text-[11px] animate-pulse">Executing...</span>
                          </>
                        ) : (
                          <>
                            <IconDiamondCheck size={14} className="text-emerald-400" />
                            <span className="text-emerald-400 text-[11px]">{call.result}</span>
                            <span className="text-zinc-600 text-[10px] ml-auto">{call.ms}</span>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Waiting cursor at the end */}
                {time >= toolCalls[toolCalls.length - 1].endAt && (
                  <div className="relative z-10 flex items-center gap-2 text-zinc-500 mt-2 pl-6 animate-fade-in">
                    <span className="w-2 h-4 bg-orange-500/50 animate-pulse" />
                  </div>
                )}
              </div>

              <div className="px-5 py-4 border-t border-[rgba(255,122,32,0.18)] bg-[rgba(0,0,0,0.4)] text-center relative z-20">
                <h4 className="text-[13px] font-mono text-[rgba(255,176,96,0.9)] flex items-center justify-center gap-2" style={{ textShadow: '0 0 12px rgba(255,176,96,0.4)' }}>
                  <IconHourglass size={14} className="text-orange-500" /> What Unbrowse Does
                </h4>
                <p className="text-[11px] text-[rgba(255,122,32,0.55)] mt-0.5 font-mono">1KB JSON <span className="text-emerald-400 font-medium">× {apiPasses} calls</span></p>
              </div>
              </div>
            </div>
            
          </div>
          
          {/* Mobile Replay Button */}
          <div className="mt-12 flex justify-center md:hidden">
            <button
              onClick={handleReplay}
              className={`flex items-center gap-2 px-5 py-2.5 border border-[rgba(255,122,32,0.3)] bg-[#060402] text-[rgba(255,122,32,0.7)] hover:text-[rgba(255,176,96,0.9)] hover:border-[rgba(255,122,32,0.5)] transition-all font-mono text-sm ${isFinished ? 'opacity-100 scale-100' : 'opacity-0 scale-95 pointer-events-none'}`}
            >
              <IconCycle size={16} />
              Replay Animation
            </button>
          </div>
        </div>
      </section>
    );
  }

