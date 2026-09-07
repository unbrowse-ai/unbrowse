/**
 * Archival Icons — custom SVG symbols designed to feel engraved, diagrammatic,
 * and cartographic. Inspired by navigation instruments, alchemical diagrams,
 * and manuscript marginalia.
 *
 * All icons accept standard SVG className and size props.
 */

interface IconProps {
  className?: string;
  size?: number;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

/** Hourglass — time, speed, reduction */
export function IconHourglass({ className, size = 24 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <path d="M5 3h14M5 21h14" />
      <path d="M5 3l7 9 7-9" />
      <path d="M5 21l7-9 7 9" />
      <line x1="8" y1="12" x2="16" y2="12" strokeWidth={0.8} />
    </svg>
  );
}

/** Compass — discovery, navigation, mapping */
export function IconCompass({ className, size = 24 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <circle cx="12" cy="12" r="8.5" strokeWidth={1.2} />
      <line x1="12" y1="3.5" x2="12" y2="6.5" />
      <line x1="12" y1="17.5" x2="12" y2="20.5" />
      <line x1="3.5" y1="12" x2="6.5" y2="12" />
      <line x1="17.5" y1="12" x2="20.5" y2="12" />
      <line x1="6.5" y1="6.5" x2="8.3" y2="8.3" strokeWidth={0.8} />
      <line x1="15.7" y1="15.7" x2="17.5" y2="17.5" strokeWidth={0.8} />
      <line x1="17.5" y1="6.5" x2="15.7" y2="8.3" strokeWidth={0.8} />
      <line x1="8.3" y1="15.7" x2="6.5" y2="17.5" strokeWidth={0.8} />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Seal — security, local, protected */
export function IconSeal({ className, size = 24 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <circle cx="12" cy="12" r="8.5" strokeWidth={1.2} />
      <circle cx="12" cy="12" r="4.5" strokeWidth={1} />
      <line x1="12" y1="3.5" x2="12" y2="7.5" />
      <line x1="12" y1="16.5" x2="12" y2="20.5" />
      <line x1="3.5" y1="12" x2="7.5" y2="12" />
      <line x1="16.5" y1="12" x2="20.5" y2="12" />
    </svg>
  );
}

/** Manuscript lines — tokens, data, economy */
export function IconScript({ className, size = 24 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="11.5" x2="20" y2="11.5" />
      <line x1="4" y1="16" x2="13" y2="16" />
      {/* serif ticks at left margin */}
      <line x1="4" y1="5" x2="4" y2="9" strokeWidth={0.8} />
      <line x1="4" y1="9.5" x2="4" y2="13.5" strokeWidth={0.8} />
      <line x1="4" y1="14" x2="4" y2="18" strokeWidth={0.8} />
    </svg>
  );
}

/** Sigil — a cartographic marker / asterisk for section labels */
export function IconSigil({ className, size = 24 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden strokeWidth={1.6}>
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="6.5" y1="6.5" x2="17.5" y2="17.5" />
      <line x1="17.5" y1="6.5" x2="6.5" y2="17.5" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Signal — activity, live, trace */
export function IconSignal({ className, size = 24 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <polyline points="2,16 6,16 6,8 9,8 9,12 12,12 12,5 15,5 15,14 18,14 18,10 22,10" />
    </svg>
  );
}

/** Diamond check — confirm, verified, done */
export function IconDiamondCheck({ className, size = 24 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <path d="M12 3L21 12L12 21L3 12Z" strokeWidth={1.2} />
      <path d="M9 12l2 2 4-4" strokeWidth={1.6} />
    </svg>
  );
}

/** Ruling arrow — precise directional */
export function IconArrow({ className, size = 24 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden strokeWidth={1.5}>
      <line x1="4" y1="12" x2="20" y2="12" />
      <path d="M15 7l5 5-5 5" />
      {/* start tick */}
      <line x1="4" y1="9.5" x2="4" y2="14.5" strokeWidth={1} />
    </svg>
  );
}

/** Chevron right — precise small directional */
export function IconChevron({ className, size = 24 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden strokeWidth={1.6}>
      <path d="M10 7l5 5-5 5" />
    </svg>
  );
}

/** Key — authentication, credentials */
export function IconKey({ className, size = 24 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <circle cx="9" cy="10" r="5" strokeWidth={1.3} />
      <circle cx="9" cy="10" r="2" strokeWidth={1} />
      <line x1="14" y1="10" x2="22" y2="10" />
      <line x1="20" y1="10" x2="20" y2="13" />
      <line x1="17.5" y1="10" x2="17.5" y2="12" />
    </svg>
  );
}

/** Frame/Viewport — screen, monitor, observed space */
export function IconFrame({ className, size = 24 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect x="3" y="4" width="18" height="14" rx="0.5" strokeWidth={1.3} />
      {/* corner bracket marks */}
      <line x1="3" y1="7" x2="6" y2="7" strokeWidth={0.8} />
      <line x1="3" y1="15" x2="6" y2="15" strokeWidth={0.8} />
      <line x1="18" y1="7" x2="21" y2="7" strokeWidth={0.8} />
      <line x1="18" y1="15" x2="21" y2="15" strokeWidth={0.8} />
      {/* base */}
      <line x1="9" y1="18" x2="15" y2="18" strokeWidth={1.2} />
      <line x1="12" y1="18" x2="12" y2="21" strokeWidth={1.2} />
      <line x1="9" y1="21" x2="15" y2="21" strokeWidth={1.2} />
    </svg>
  );
}

/** Terminal/Console — code execution, agent interface */
export function IconTerminal({ className, size = 24 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="0.5" strokeWidth={1.3} />
      <line x1="3" y1="8.5" x2="21" y2="8.5" strokeWidth={0.8} />
      {/* > prompt */}
      <path d="M7 13l3 2-3 2" strokeWidth={1.4} />
      {/* cursor line */}
      <line x1="12" y1="15" x2="17" y2="15" strokeWidth={1.3} />
    </svg>
  );
}

/** Code brackets — tool call, function */
export function IconCode({ className, size = 24 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden strokeWidth={1.5}>
      <path d="M8 6L3 12l5 6" />
      <path d="M16 6l5 6-5 6" />
      <line x1="14" y1="4" x2="10" y2="20" strokeWidth={0.8} />
    </svg>
  );
}

/** Cycle/Rotate — replay, refresh, recurrence */
export function IconCycle({ className, size = 24 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <path d="M20 8A9 9 0 0 0 5.5 5.5" strokeWidth={1.4} />
      <path d="M4 16a9 9 0 0 0 14.5 2.5" strokeWidth={1.4} />
      {/* arrowheads */}
      <path d="M20 4v4h-4" strokeWidth={1.4} />
      <path d="M4 20v-4h4" strokeWidth={1.4} />
    </svg>
  );
}

/** Aperture — camera, capture, observation */
export function IconAperture({ className, size = 24 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <circle cx="12" cy="12" r="8.5" strokeWidth={1.2} />
      <circle cx="12" cy="12" r="3" strokeWidth={1} />
      {/* aperture blades — 6 chord lines */}
      <line x1="12" y1="3.5" x2="9" y2="9" strokeWidth={0.7} />
      <line x1="20.5" y1="9" x2="14.5" y2="9.5" strokeWidth={0.7} />
      <line x1="17.5" y1="20" x2="13" y2="15" strokeWidth={0.7} />
      <line x1="3.5" y1="15" x2="9.5" y2="14.5" strokeWidth={0.7} />
      <line x1="6.5" y1="4" x2="11" y2="9" strokeWidth={0.7} />
      <line x1="17.5" y1="4" x2="15" y2="9.5" strokeWidth={0.7} />
    </svg>
  );
}

/** Spinner/Loading — in progress, executing */
export function IconSpinner({ className, size = 24 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <circle cx="12" cy="12" r="8.5" strokeWidth={1.2} strokeDasharray="4 3" />
      <line x1="12" y1="3.5" x2="12" y2="7" strokeWidth={1.5} />
    </svg>
  );
}

/** Node — network point, agent, endpoint */
export function IconNode({ className, size = 24 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <circle cx="12" cy="12" r="4" strokeWidth={1.3} />
      <line x1="12" y1="3" x2="12" y2="8" strokeWidth={1} />
      <line x1="12" y1="16" x2="12" y2="21" strokeWidth={1} />
      <line x1="3" y1="12" x2="8" y2="12" strokeWidth={1} />
      <line x1="16" y1="12" x2="21" y2="12" strokeWidth={1} />
      <line x1="5.6" y1="5.6" x2="8.9" y2="8.9" strokeWidth={0.8} />
      <line x1="15.1" y1="15.1" x2="18.4" y2="18.4" strokeWidth={0.8} />
      <line x1="18.4" y1="5.6" x2="15.1" y2="8.9" strokeWidth={0.8} />
      <line x1="8.9" y1="15.1" x2="5.6" y2="18.4" strokeWidth={0.8} />
    </svg>
  );
}
