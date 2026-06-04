"use client";

/*
 * Generative UI for Aiko — json-render.dev (@json-render/react).
 *
 * When the model returns a json-render spec (a flat tree of typed elements), we
 * render it as NATIVE themed React components (no iframes, no arbitrary code) via
 * <Renderer>. Otherwise the answer falls back to streaming markdown (Streamdown),
 * handled by the caller.
 *
 * The component vocabulary below IS the default design skill applied: the atoms
 * map to DESIGN.md (src/skills/design.md) — Card/Heading/Text/Stat/Badge/List/
 * Button — unbrowse-themed (orange-on-near-black, the design tokens). The model is
 * told to compose only from this catalog (the "called by default" design skill).
 */

import {
  Renderer,
  JSONUIProvider,
  type ComponentRegistry,
  type ComponentRenderProps,
} from "@json-render/react";
import type { Spec } from "@json-render/core";

// The default design skill that governs this catalog (jesus-pattern DESIGN method).
export const DEFAULT_DESIGN_SKILL = "src/skills/design.md";

/**
 * System prompt that makes the Aiko agent emit generative UI. Sent as a system
 * message on every chat request, so the model returns a json-render spec for
 * structured answers (the catalog below = the DESIGN skill, applied by default).
 */
export const GENUI_SYSTEM_PROMPT =
  'You can answer with GENERATIVE UI. When the answer is structured (a comparison, ' +
  'a ranked list, key stats/metrics, steps, or a card-worthy summary), respond with ' +
  'a json-render spec in a fenced ```json-ui block INSTEAD of prose. Shape: ' +
  '{"root":"<id>","elements":{"<id>":{"type":"<Type>","props":{...},"children":["<id>",...]}}}. ' +
  'Use ONLY these component types: Card{title}, Heading{text}, Text{text}, ' +
  'Stat{label,value}, Badge{text}, List(children), ListItem{text}, Row(children), ' +
  'Button{label,href}, Link{label,href}. Every element is {type, props, children?:[ids]}; ' +
  'children reference other element ids. Keep it under ~15 elements and return ONLY the ' +
  'fenced ```json-ui block for those cases. For plain conversational answers, reply in ' +
  'normal markdown with no spec.';

type P = Record<string, unknown>;
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

const Card = ({ element, children }: ComponentRenderProps<P>) => (
  <div className="rounded-2xl border border-border bg-surface-raised p-5">
    {str(element.props.title) && <h3 className="text-[15px] font-semibold text-text-primary mb-2">{str(element.props.title)}</h3>}
    {children}
  </div>
);
const Heading = ({ element }: ComponentRenderProps<P>) => (
  <h2 className="text-[18px] font-semibold text-text-primary">{str(element.props.text)}</h2>
);
const Text = ({ element }: ComponentRenderProps<P>) => (
  <p className="text-[14px] leading-relaxed text-text-secondary">{str(element.props.text)}</p>
);
const Badge = ({ element }: ComponentRenderProps<P>) => (
  <span className="inline-block px-2 py-0.5 rounded-full text-[11px]" style={{ border: "1px solid var(--border)", color: "var(--orange-400, #FF6A00)" }}>{str(element.props.text)}</span>
);
const Stat = ({ element }: ComponentRenderProps<P>) => (
  <div>
    <div className="text-[20px] font-semibold text-text-primary">{str(element.props.value)}</div>
    <div className="text-[11px] uppercase tracking-[0.16em] text-text-muted">{str(element.props.label)}</div>
  </div>
);
const List = ({ children }: ComponentRenderProps<P>) => <ul className="grid gap-2">{children}</ul>;
const ListItem = ({ element, children }: ComponentRenderProps<P>) => (
  <li className="text-[14px] text-text-secondary">{str(element.props.text)}{children}</li>
);
const Row = ({ children }: ComponentRenderProps<P>) => <div className="flex flex-wrap gap-4 items-center">{children}</div>;
const LinkBtn = ({ element, emit }: ComponentRenderProps<P>) => (
  <a
    href={str(element.props.href, "#")}
    onClick={() => emit("press")}
    className="inline-block px-4 py-2 rounded-xl text-[13px] font-medium"
    style={{ background: "var(--orange-500, #FF5200)", color: "#0c0500" }}
  >
    {str(element.props.label, "Open")}
  </a>
);

// The catalog the model composes from (the default design skill, applied).
const REGISTRY: ComponentRegistry = {
  Card,
  Heading,
  Text,
  Badge,
  Stat,
  List,
  ListItem,
  Row,
  Button: LinkBtn,
  Link: LinkBtn,
};

/**
 * Pull a json-render spec out of a model answer. Supports a fenced ```json-ui
 * block or a raw leading {root, elements} object. Returns null if none/invalid.
 */
export function extractUiSpec(content: string): Spec | null {
  if (!content) return null;
  const fence = content.match(/```(?:json-ui|jsonui|ui)\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : content.trim().startsWith("{") ? content : null;
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === "object" && "root" in obj && "elements" in obj) {
      return obj as Spec;
    }
  } catch {
    /* not a spec — fall back to markdown */
  }
  return null;
}

export function GenerativeUI({ spec }: { spec: Spec }) {
  return (
    <JSONUIProvider registry={REGISTRY}>
      <Renderer spec={spec} registry={REGISTRY} />
    </JSONUIProvider>
  );
}
