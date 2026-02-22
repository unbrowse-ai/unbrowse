"use client";

export function ThreePanelVisual() {
  return (
    <section className="relative py-24 border-b border-border overflow-hidden">
      <div className="absolute inset-0 bg-gradient-radial from-orange-500/3 via-transparent to-transparent opacity-50" />
      <div className="relative max-w-7xl mx-auto px-6">
        <div className="text-center mb-14">
          <span className="text-xs font-mono text-orange-500 uppercase tracking-widest">The Problem</span>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mt-3 mb-4">
            Three ways to see <span className="gradient-text">the same website</span>
          </h2>
        </div>

        <div className="grid lg:grid-cols-3 gap-5">
          {/* What Humans See */}
          <div className="rounded-2xl border border-border bg-surface overflow-hidden">
            <div className="px-5 py-3 border-b border-border flex items-center gap-2">
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
                <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
              </div>
              <span className="text-xs text-text-muted font-mono ml-2">travelbooker.com</span>
            </div>
            <div className="p-5 space-y-3">
              {/* Mock website UI */}
              <div className="flex items-center justify-between">
                <div className="w-20 h-5 bg-blue-500/20 rounded" />
                <div className="flex gap-2">
                  <div className="w-12 h-4 bg-text-muted/10 rounded" />
                  <div className="w-12 h-4 bg-text-muted/10 rounded" />
                  <div className="w-12 h-4 bg-text-muted/10 rounded" />
                </div>
              </div>
              <div className="w-full h-28 bg-gradient-to-br from-blue-500/15 to-purple-500/15 rounded-xl flex items-center justify-center">
                <div className="text-center space-y-2">
                  <div className="w-32 h-3 bg-white/20 rounded mx-auto" />
                  <div className="w-24 h-2 bg-white/10 rounded mx-auto" />
                  <div className="w-16 h-6 bg-orange-500/30 rounded-md mx-auto" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="h-16 bg-text-muted/5 rounded-lg border border-border" />
                <div className="h-16 bg-text-muted/5 rounded-lg border border-border" />
                <div className="h-16 bg-text-muted/5 rounded-lg border border-border" />
              </div>
              <div className="flex gap-2">
                <div className="flex-1 h-8 bg-text-muted/5 rounded-lg border border-border" />
                <div className="w-20 h-8 bg-blue-500/20 rounded-lg" />
              </div>
            </div>
            <div className="px-5 py-3 border-t border-border text-center">
              <span className="text-sm font-semibold text-text-primary">What Humans See</span>
              <p className="text-xs text-text-muted mt-0.5">Beautiful, interactive UI</p>
            </div>
          </div>

          {/* What Agents See Today */}
          <div className="rounded-2xl border border-red-500/25 bg-surface overflow-hidden">
            <div className="px-5 py-3 border-b border-red-500/15 flex items-center gap-2">
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
                <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
              </div>
              <span className="text-xs text-red-400/80 font-mono ml-2">view-source:travelbooker.com</span>
            </div>
            <div className="p-4 font-mono text-[10px] leading-[1.6] text-red-400/60 overflow-hidden h-[272px] relative">
              <div className="select-none">
                {`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="w`}
                <br />
                {`idth=device-width"/><script>var _0x3f2a=function(_0x2b1c){var _0x4e3d=_0x2b1c.split("").reve`}
                <br />
                {`rse().join("");return atob(_0x4e3d)};window.__CF={};(function(){var a="x3f",b=document.creat`}
                <br />
                {`eElement("div");b.className="x3f"+a;b.id="_0x"+Math.random().toString(36).substr(2,9);</scr`}
                <br />
                {`ipt><link rel="stylesheet" href="/_next/static/css/a3b2c1d.css"/><style>.x3f{display:flex;fl`}
                <br />
                {`ex-direction:column}.x3f>div{padding:0}.x3f .k9m{background:linear-gradient(135deg,#667eea`}
                <br />
                {` 0%,#764ba2 100%)}.x3f .q7p{position:absolute;top:0;left:0;right:0;bottom:0;z-index:1}.x3`}
                <br />
                {`f .r2w{font-size:clamp(1.5rem,4vw,3rem);font-weight:800;letter-spacing:-.02em;line-height`}
                <br />
                {`:1.1}</style></head><body><div id="__next"><div class="x3f"><div class="x3f q7p"><nav clas`}
                <br />
                {`s="x3f k9m"><div class="x3f"><a href="/" class="x3f r2w">TravelBooker</a><div class="x3f"`}
                <br />
                {`><a href="/flights" class="x3f">Flights</a><a href="/hotels" class="x3f">Hotels</a></div>`}
                <br />
                {`</div></nav><main class="x3f"><div class="x3f k9m"><h1 class="x3f r2w">Find your perfect `}
                <br />
                {`getaway</h1><form class="x3f" action="/search" method="GET"><input class="x3f" name="q" pl`}
              </div>
              <div className="absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-surface to-transparent" />
            </div>
            <div className="px-5 py-3 border-t border-red-500/15 text-center">
              <span className="text-sm font-semibold text-red-400">What Agents See Today</span>
              <p className="text-xs text-red-400/60 mt-0.5 font-mono">847KB of noise</p>
            </div>
          </div>

          {/* What Unbrowse Sees */}
          <div className="rounded-2xl border border-emerald-500/25 bg-surface overflow-hidden">
            <div className="px-5 py-3 border-b border-emerald-500/15 flex items-center gap-2">
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
                <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
              </div>
              <span className="text-xs text-emerald-400/80 font-mono ml-2">unbrowse → travelbooker.com</span>
            </div>
            <div className="p-5 space-y-3">
              {[
                { method: "GET", path: "/api/search", desc: "Search listings" },
                { method: "POST", path: "/api/book", desc: "Create booking" },
                { method: "GET", path: "/api/reviews", desc: "Fetch reviews" },
                { method: "GET", path: "/api/availability", desc: "Check dates" },
              ].map((ep) => (
                <div key={ep.path} className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/15">
                  <div className="flex items-center gap-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ${
                      ep.method === "POST" ? "bg-amber-500/15 text-amber-400" : "bg-emerald-500/15 text-emerald-400"
                    }`}>
                      {ep.method}
                    </span>
                    <code className="text-sm font-mono text-text-primary">{ep.path}</code>
                  </div>
                  <p className="text-xs text-text-muted mt-1">{ep.desc}</p>
                </div>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-emerald-500/15 text-center">
              <span className="text-sm font-semibold text-emerald-400">What Unbrowse Sees</span>
              <p className="text-xs text-emerald-400/60 mt-0.5 font-mono">4 clean endpoints</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
