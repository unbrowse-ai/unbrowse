"use client";

import { useState } from "react";
import { GitBookProvider, GitBookFrame } from "@gitbook/embed/react";
import { BookOpen, X } from "lucide-react";

export function DocsEmbed() {
  const [open, setOpen] = useState(false);

  return (
    <GitBookProvider siteURL="https://docs.unbrowse.ai">
      {/* Floating toggle button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-orange-500 text-white flex items-center justify-center shadow-[0_0_24px_rgba(255,109,0,0.4)] hover:bg-orange-600 hover:shadow-[0_0_32px_rgba(255,109,0,0.6)] transition-all active:scale-95"
        aria-label={open ? "Close docs" : "Open docs"}
      >
        {open ? <X className="w-5 h-5" /> : <BookOpen className="w-5 h-5" />}
      </button>

      {/* Docs panel */}
      {open && (
        <div className="fixed bottom-24 right-6 z-50 w-[400px] h-[600px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-8rem)] rounded-2xl overflow-hidden border border-border bg-surface shadow-2xl">
          <GitBookFrame
            className="w-full h-full"
            suggestions={[
              "How do I install Unbrowse?",
              "How does the skill registry work?",
              "How do I use Unbrowse with Claude Code?",
            ]}
            tabs={["assistant", "docs"]}
            greeting={{
              title: "Unbrowse Docs",
              subtitle: "Ask anything about Unbrowse or browse the docs.",
            }}
          />
        </div>
      )}
    </GitBookProvider>
  );
}
