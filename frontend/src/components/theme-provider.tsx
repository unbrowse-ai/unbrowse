"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";

type Theme = "light" | "dark";

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: "light",
  toggle: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      // Source of truth on load: an explicit saved choice wins; otherwise follow
      // the OS preference (already applied pre-paint by the no-flash script in
      // <head>). We do NOT persist here — system preference is respected on every
      // visit until the visitor explicitly toggles.
      const stored = localStorage.getItem("unbrowse-theme") as Theme | null;
      const domAttr = document.documentElement.getAttribute("data-theme") as Theme | null;
      const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      setTheme(stored ?? domAttr ?? preferred);
      setMounted(true);
    } catch (error) {
      // Fallback for SSR or environments without localStorage
      setMounted(true);
    }
  }, []);

  useEffect(() => {
    if (!mounted) return;
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme, mounted]);

  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === "light" ? "dark" : "light";
      try {
        // Only an explicit toggle persists — this is the visitor's stated choice.
        localStorage.setItem("unbrowse-theme", next);
      } catch (error) {
        // ignore storage failures (private mode, SSR)
      }
      return next;
    });
  }, []);

  return (
    <ThemeContext value={{ theme, toggle }}>
      {children}
    </ThemeContext>
  );
}
