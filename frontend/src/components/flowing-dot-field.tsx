'use client';

import { useEffect, useRef } from 'react';

// ── Perlin noise ─────────────────────────────────────────────────────────────
const PERM = [
  151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,
  69,142,8,99,37,240,21,10,23,190,6,148,247,120,234,75,0,26,197,62,94,
  252,219,203,117,35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,
  168,68,175,74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,60,
  211,133,230,220,105,92,41,55,46,245,40,244,102,143,54,65,25,63,161,1,
  216,80,73,209,76,132,187,208,89,18,169,200,196,135,130,116,188,159,86,
  164,100,109,198,173,186,3,64,52,217,226,250,124,123,5,202,38,147,118,
  126,255,82,85,212,207,206,59,227,47,16,58,17,182,189,28,42,223,183,170,
  213,119,248,152,2,44,154,163,70,221,153,101,155,167,43,172,9,129,22,39,
  253,19,98,108,110,79,113,224,232,178,185,112,104,218,246,97,228,251,34,
  242,193,238,210,144,12,191,179,162,241,81,51,145,235,249,14,239,107,49,
  192,214,31,181,199,106,157,184,84,204,176,115,121,50,45,127,4,150,254,
  138,236,205,93,222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180,
];
const p: number[] = (() => { const a = new Array<number>(512); for (let i = 0; i < 256; i++) a[256+i]=a[i]=PERM[i]; return a; })();
function fade(t: number) { return t*t*t*(t*(t*6-15)+10); }
function lerp(a: number, b: number, t: number) { return a+t*(b-a); }
function grad(h: number, x: number, y: number, z: number) {
  const hh=h&15, u=hh<8?x:y, v=hh<4?y:(hh===12||hh===14)?x:z;
  return ((hh&1)?-u:u)+((hh&2)?-v:v);
}
function noise(x: number, y: number, z: number): number {
  const X=Math.floor(x)&255, Y=Math.floor(y)&255, Z=Math.floor(z)&255;
  x-=Math.floor(x); y-=Math.floor(y); z-=Math.floor(z);
  const u=fade(x), v=fade(y), w=fade(z);
  const A=p[X]+Y, AA=p[A]+Z, AB=p[A+1]+Z, B=p[X+1]+Y, BA=p[B]+Z, BB=p[B+1]+Z;
  return lerp(
    lerp(lerp(grad(p[AA],x,y,z),grad(p[BA],x-1,y,z),u),lerp(grad(p[AB],x,y-1,z),grad(p[BB],x-1,y-1,z),u),v),
    lerp(lerp(grad(p[AA+1],x,y,z-1),grad(p[BA+1],x-1,y,z-1),u),lerp(grad(p[AB+1],x,y-1,z-1),grad(p[BB+1],x-1,y-1,z-1),u),v),
    w
  );
}

// ── Static grain map ──────────────────────────────────────────────────────────
const GRAIN_COLS = 340, GRAIN_ROWS = 200;
const grainMap = new Float32Array(GRAIN_COLS * GRAIN_ROWS);
for (let i = 0; i < grainMap.length; i++) {
  const r = Math.random();
  if (r < 0.10)      grainMap[i] = Math.random() * 0.22;
  else if (r > 0.88) grainMap[i] = 0.88 + Math.random() * 0.12;
  else               grainMap[i] = 0.32 + Math.random() * 0.56;
}

// ── Config ────────────────────────────────────────────────────────────────────
const SPACING   = 6;
const DOT_SIZE  = 2.8;
const THRESHOLD = 0.06;
const NOISE_XY  = 0.038;
const NOISE_SPD = 0.0012;
const DRIFT_X   = 0.005;   // slow noise-space drift — makes pattern visibly travel
const DRIFT_Y   = 0.002;
const REPEL_R   = 140;     // px — repulsion radius around cursor
const REPEL_STR = 110;     // px — max displacement

export function FlowingDotField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef  = useRef({ x: -9999, y: -9999 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf: number;
    let frame = 0;
    let imgData: ImageData | null = null;

    const resize = () => {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
      imgData = ctx.createImageData(canvas.width, canvas.height);
    };

    const draw = () => {
      const w = canvas.width, h = canvas.height;
      if (!imgData || imgData.width !== w || imgData.height !== h) {
        imgData = ctx.createImageData(w, h);
      }
      const data = imgData.data;
      data.fill(0);

      const { x: mx, y: my } = mouseRef.current;
      const cols = Math.ceil(w / SPACING) + 1;
      const rows = Math.ceil(h / SPACING) + 1;
      const nt   = frame * NOISE_SPD;

      // Noise-space drift — the bright cloud regions slowly travel across screen
      const driftNX = frame * DRIFT_X;
      const driftNY = frame * DRIFT_Y;

      const half     = DOT_SIZE * 0.5;
      const REPEL_R2 = REPEL_R * REPEL_R;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const nx = c * NOISE_XY + driftNX;
          const ny = r * NOISE_XY + driftNY;

          const n =
            noise(nx,       ny,       nt)        * 0.55 +
            noise(nx * 2.2, ny * 2.2, nt * 1.9)  * 0.30 +
            noise(nx * 5.0, ny * 5.0, nt * 3.5)  * 0.15;

          const v    = (n + 1) * 0.5;
          const base = 0.08 + v * 0.82;
          const gi   = (r % GRAIN_ROWS) * GRAIN_COLS + (c % GRAIN_COLS);
          const alpha = base * grainMap[gi];
          if (alpha < THRESHOLD) continue;

          const a255 = Math.min(255, (alpha * 230) | 0);

          // Grid home position
          const gx = c * SPACING;
          const gy = r * SPACING;

          // Mouse repulsion — push dots outward, leaving a transparent hole
          let ox = 0, oy = 0;
          const ddx = gx - mx, ddy = gy - my;
          const dist2 = ddx * ddx + ddy * ddy;
          if (dist2 < REPEL_R2 && dist2 > 0.01) {
            const dist = Math.sqrt(dist2);
            const t    = 1 - dist / REPEL_R;
            const str  = t * t * t * REPEL_STR;  // cubic falloff — strong near cursor
            ox = (ddx / dist) * str;
            oy = (ddy / dist) * str;
          }

          // Subtle sinusoidal wave drift — gives the field a gentle floating feel
          const wave  = Math.sin(frame * 0.008 + c * 0.28 + r * 0.19) * 1.2;
          const waveY = Math.cos(frame * 0.008 + c * 0.19 - r * 0.24) * 0.8;

          const drawX = (gx + ox + wave)  | 0;
          const drawY = (gy + oy + waveY) | 0;

          // Write square dot pixels into ImageData
          const x0 = Math.max(0,   (drawX - half + 0.5) | 0);
          const y0 = Math.max(0,   (drawY - half + 0.5) | 0);
          const x1 = Math.min(w-1, (drawX + half - 0.5) | 0);
          const y1 = Math.min(h-1, (drawY + half - 0.5) | 0);

          for (let py = y0; py <= y1; py++) {
            const rowOff = py * w;
            for (let px = x0; px <= x1; px++) {
              const idx = (rowOff + px) * 4;
              data[idx]     = 255;
              data[idx + 1] = 72;
              data[idx + 2] = 0;
              data[idx + 3] = a255;
            }
          }
        }
      }

      ctx.putImageData(imgData, 0, 0);
      frame++;
      raf = requestAnimationFrame(draw);
    };

    const onMove  = (e: MouseEvent) => { mouseRef.current = { x: e.clientX, y: e.clientY }; };
    const onLeave = ()               => { mouseRef.current = { x: -9999, y: -9999 }; };

    resize();
    window.addEventListener('resize',      resize);
    window.addEventListener('mousemove',   onMove,  { passive: true });
    document.addEventListener('mouseleave', onLeave);
    draw();

    return () => {
      window.removeEventListener('resize',      resize);
      window.removeEventListener('mousemove',   onMove);
      document.removeEventListener('mouseleave', onLeave);
      cancelAnimationFrame(raf);
    };
  }, []);

  // Code lines that appear when dots part
  const codeLines = [
    'GET /api/v3/StaysSearch?query=Tokyo&checkin=2024-03-15&guests=2&currency=USD',
    '{"listings":[{"id":"TKY-882","price":89,"rating":4.92,"title":"Shibuya Loft with City View"}',
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>TravelBooker</title><link rel="stylesheet"',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzEyMzQ1In0',
    'unbrowse.resolve({ url: "airbnb.com", intent: "find Tokyo stays for 2 guests, March 15-22" })',
    '<div class="listing" data-id="TKY-882"><span class="price">$89/night</span><span class="rating">4.92★</span>',
    'Content-Type: application/json  ·  200 OK  ·  0.4s  ·  1.2KB  ·  cache: hit',
    'POST /api/v3/StayCheckout {"listing_id":"TKY-882","dates":{"checkin":"2024-03-15","checkout":"2024-03-22"}}',
    'skill: airbnb-stays-api  ·  quality: 91/100  ·  endpoints: 12  ·  indexed: public registry',
    'import { unbrowse } from "unbrowse"  // 100x faster than headless browsers, 40x fewer tokens',
    'X-Request-ID: 3f2a8b91  ·  X-RateLimit-Remaining: 998  ·  Cache-Control: public, max-age=60',
    'response.listings.map(l => `${l.title}: $${l.price}/night — ${l.rating}★`).join("\\n")',
    'GET /api/v3/PdpAvailabilityCalendar?id=TKY-882&month=2024-03  →  {"available":true,"price_override":null}',
    'unbrowse.skill("airbnb-stays-api").call("search", { location: "Tokyo", dates: "Mar 15-22" })',
    'var _0x3f2a=function(_0x2b1c){return _0x2b1c.split("").reverse()};window.__CF={};(function(){',
  ];

  return (
    <>
      {/* Background code text — revealed when dots are repelled by cursor */}
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 0,
          pointerEvents: 'none',
          overflow: 'hidden',
          fontFamily: "'Courier New', 'Lucida Console', monospace",
          fontSize: '10px',
          lineHeight: '20px',
          color: 'rgba(255,82,0,0.22)',
          padding: '4px 8px',
          userSelect: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        {Array.from({ length: 65 }, (_, i) => {
          const line = codeLines[i % codeLines.length];
          return (
            <div key={i}>
              {line}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
              {codeLines[(i + 5) % codeLines.length]}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
              {codeLines[(i + 10) % codeLines.length]}
            </div>
          );
        })}
      </div>

      {/* Animated dot canvas */}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          width: '100%',
          height: '100%',
          zIndex: 1,
          pointerEvents: 'none',
        }}
      />
    </>
  );
}
