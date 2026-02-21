"use client";

import { useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
  pulse: number;
  pulseSpeed: number;
}

export function Constellation() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: -1000, y: -1000 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationId: number;
    let particles: Particle[] = [];
    let dpr = window.devicePixelRatio || 1;

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    window.addEventListener("resize", resize);

    const w = () => canvas.offsetWidth;
    const h = () => canvas.offsetHeight;

    // Create particles — more, varied sizes
    for (let i = 0; i < 80; i++) {
      particles.push({
        x: Math.random() * w(),
        y: Math.random() * h(),
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
        radius: Math.random() * 2 + 0.5,
        alpha: Math.random() * 0.6 + 0.15,
        pulse: Math.random() * Math.PI * 2,
        pulseSpeed: 0.01 + Math.random() * 0.02,
      });
    }

    // Mouse tracking for interactive glow
    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const handleMouseLeave = () => {
      mouseRef.current = { x: -1000, y: -1000 };
    };
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseleave", handleMouseLeave);

    const draw = () => {
      const cw = w();
      const ch = h();
      ctx.clearRect(0, 0, cw, ch);

      const mx = mouseRef.current.x;
      const my = mouseRef.current.y;

      particles.forEach((p, i) => {
        // Gentle mouse repulsion
        const dxm = p.x - mx;
        const dym = p.y - my;
        const distMouse = Math.hypot(dxm, dym);
        if (distMouse < 150 && distMouse > 0) {
          const force = (150 - distMouse) / 150 * 0.3;
          p.vx += (dxm / distMouse) * force;
          p.vy += (dym / distMouse) * force;
        }

        // Dampen velocity
        p.vx *= 0.99;
        p.vy *= 0.99;

        // Minimum drift
        const speed = Math.hypot(p.vx, p.vy);
        if (speed < 0.1) {
          p.vx += (Math.random() - 0.5) * 0.05;
          p.vy += (Math.random() - 0.5) * 0.05;
        }

        p.x += p.vx;
        p.y += p.vy;

        // Wrap
        if (p.x < -10) p.x = cw + 10;
        if (p.x > cw + 10) p.x = -10;
        if (p.y < -10) p.y = ch + 10;
        if (p.y > ch + 10) p.y = -10;

        // Pulsing alpha
        p.pulse += p.pulseSpeed;
        const alpha = p.alpha * (0.7 + 0.3 * Math.sin(p.pulse));

        // Draw particle with glow
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 109, 0, ${alpha})`;
        ctx.fill();

        // Subtle glow around larger particles
        if (p.radius > 1.2) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.radius * 3, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 109, 0, ${alpha * 0.08})`;
          ctx.fill();
        }

        // Draw connections
        for (let j = i + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dx = p.x - p2.x;
          const dy = p.y - p2.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 160) {
            const lineAlpha = 0.12 * (1 - dist / 160);
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = `rgba(255, 109, 0, ${lineAlpha})`;
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      });

      animationId = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
      cancelAnimationFrame(animationId);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{ opacity: 0.7, pointerEvents: "auto" }}
    />
  );
}
