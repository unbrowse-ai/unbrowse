'use client';

import { useEffect, useRef } from 'react';

// A continuous string of HTML/CSS source — each cell in the grid shows one char from this, tiling
const HTML_WALL =
  '<divclass="x3fq7p"data-v="1">GET/api/v2/searchHTTP/1.1' +
  'Authorization:Bearertok_x3f9Content-Type:application/json' +
  '{"endpoint":"discovered","shadow":true,"auth":"session"}' +
  '.hidden{display:none;opacity:0;visibility:hidden}' +
  '.x3f{position:absolute;left:-9999px;clip:rect(0)}' +
  'fetch("/api/v2/listings?q="+encodeURI(intent))' +
  '<spanaria-hidden="true">$182/night</span>' +
  'POSTv1/checkoutContent-Length:284' +
  'input[type=hidden]name="tok"value="x3f9a"' +
  'XHR→/api/prices?id=8821&locale=en_US' +
  'rate_limit:nullx-api-key:extracted' +
  'unbrowse.map()shadow_api.resolve()' +
  'skill.cache.hit:true{"data":[...47]}';

// Only keep printable non-space chars for the grid
const CHARS = HTML_WALL.replace(/\s/g, '').split('');

const MAX_RADIUS  = 32;
const MIN_RADIUS  = 4;
const SPEED_LOW   = 0.08;
const SPEED_HIGH  = 1.2;
const FADE_SPEED  = 0.009;
const REVEAL_SPEED = 0.2;
const COL_GAP     = 14;
const ROW_GAP     = 14;
const FONT_SIZE   = 10;

type CellState = 'hidden' | 'showing' | 'fading';

interface Cell {
  x: number;
  y: number;
  char: string;
  alpha: number;
  state: CellState;
}

export function CursorParticles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cells     = useRef<Cell[]>([]);
  const mouse     = useRef({ x: -9999, y: -9999 });
  const speed     = useRef(0);
  const lastPos   = useRef({ x: -9999, y: -9999, t: 0 });
  const rafId     = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const buildGrid = () => {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
      cells.current = [];
      const cols = Math.ceil(canvas.width  / COL_GAP) + 2;
      const rows = Math.ceil(canvas.height / ROW_GAP) + 2;
      let idx = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          cells.current.push({
            x: c * COL_GAP,
            y: r * ROW_GAP + FONT_SIZE,
            char: CHARS[idx % CHARS.length],
            alpha: 0,
            state: 'hidden',
          });
          idx++;
        }
      }
    };
    buildGrid();
    window.addEventListener('resize', buildGrid);

    const isBackground = (el: Element | null): boolean => {
      let cur = el; let depth = 0;
      while (cur && cur !== document.body && depth < 12) {
        const tag = cur.tagName.toLowerCase();
        if (['a','button','input','select','textarea','nav','footer',
             'p','h1','h2','h3','h4','h5','h6','span','li','label','code','pre','strong','em'].includes(tag)) return false;
        const cls = typeof cur.className === 'string' ? cur.className : '';
        if (cls.includes('backdrop-blur') || cls.includes('bg-black/') ||
            cls.includes('bg-white/')     || cls.includes('rounded-2xl') ||
            cls.includes('rounded-xl')    || cls.includes('rounded-full') ||
            cls.includes('border-white')  || cls.includes('bento') || cls.includes('card'))
          return false;
        cur = cur.parentElement; depth++;
      }
      return true;
    };

    const onMove = (e: MouseEvent) => {
      const now = Date.now();
      const dt  = Math.max(1, now - lastPos.current.t);
      const dx  = e.clientX - lastPos.current.x;
      const dy  = e.clientY - lastPos.current.y;
      speed.current = speed.current * 0.65 + (Math.sqrt(dx*dx + dy*dy) / dt) * 0.35;
      lastPos.current = { x: e.clientX, y: e.clientY, t: now };
      const under = document.elementFromPoint(e.clientX, e.clientY);
      mouse.current = isBackground(under) ? { x: e.clientX, y: e.clientY } : { x: -9999, y: -9999 };
    };
    const onLeave = () => { mouse.current = { x: -9999, y: -9999 }; };
    window.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', onLeave);

    const FONT_STR = `${FONT_SIZE}px 'SFMono-Regular','SF Mono',Menlo,monospace`;

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = FONT_STR;
      const mx = mouse.current.x;
      const my = mouse.current.y;

      speed.current *= 0.90;
      const t      = Math.min(1, Math.max(0, (speed.current - SPEED_LOW) / (SPEED_HIGH - SPEED_LOW)));
      const radius = MAX_RADIUS * (1 - t) + MIN_RADIUS * t;
      const r2     = radius * radius;

      for (const cell of cells.current) {
        const dx      = cell.x - mx;
        const dy      = cell.y - my;
        const inRange = dx * dx + dy * dy < r2;

        switch (cell.state) {
          case 'hidden':
            if (inRange) { cell.state = 'showing'; cell.alpha = 0; }
            break;
          case 'showing':
            cell.alpha = Math.min(1, cell.alpha + REVEAL_SPEED);
            if (!inRange) cell.state = 'fading';
            break;
          case 'fading':
            cell.alpha -= FADE_SPEED;
            if (cell.alpha <= 0) { cell.alpha = 0; cell.state = 'hidden'; }
            else if (inRange)    { cell.state = 'showing'; }
            break;
        }

        if (cell.alpha > 0.004) {
          ctx.globalAlpha = cell.alpha * 0.36;
          ctx.fillStyle   = 'rgba(255, 82, 0, 1)';
          ctx.fillText(cell.char, cell.x, cell.y);
        }
      }

      rafId.current = requestAnimationFrame(animate);
    };
    rafId.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener('resize', buildGrid);
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onLeave);
      cancelAnimationFrame(rafId.current);
    };
  }, []);

  return <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none" style={{ zIndex: 0 }} />;
}
