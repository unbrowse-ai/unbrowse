import { Chapter } from "../chapter";
import { InstallInstructions } from "@/components/install-instructions";

/**
 * Chapter [05] — Install.
 *
 * Source: MAY18-INVENTORY §3 Install. The parchment `#ede0c2` terminal
 * background is acceptable on cream because it IS a contained card,
 * not a chapter surface. The Saint Eagle bleed from the legacy
 * InstallFigure is dropped from Wave-2A; chapter stays focused on
 * the canonical one-paste install.
 *
 * Compat strip lists the agent stack we wire into.
 */
export function Ch05Install() {
  return (
    <Chapter
      id="install"
      number="[05]"
      name="Install"
      title="$ unbrowse setup --mcp"
      lede="Wires the Unbrowse MCP server into your agent host. One command per client."
    >
      <div className="install-host">
        <InstallInstructions />
      </div>

      <div className="install-compat">
        <span className="install-compat-eyebrow">
          ## Plugs into the agent stack you already use
        </span>
        <p className="install-compat-list">
          Claude Code <span aria-hidden="true">·</span> Claude Desktop{" "}
          <span aria-hidden="true">·</span> Cursor{" "}
          <span aria-hidden="true">·</span> Codex{" "}
          <span aria-hidden="true">·</span> Windsurf{" "}
          <span aria-hidden="true">·</span> OpenClaw{" "}
          <span aria-hidden="true">·</span> any MCP framework.
        </p>
      </div>

      <style>{`
        .install-host {
          border-radius: 0.75rem;
          overflow: hidden;
          margin-bottom: clamp(1.5rem, 3vw, 2.25rem);
        }
        .install-compat {
          padding-top: clamp(1rem, 2vw, 1.5rem);
          border-top: 1px solid var(--ed-hairline-faint);
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
        .install-compat-eyebrow {
          font-family: var(--font-mono);
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.25em;
          color: var(--ed-ink-muted);
        }
        .install-compat-list {
          font-family: var(--font-mono);
          font-size: 0.95rem;
          line-height: 1.5;
          color: var(--ed-ink);
          margin: 0;
        }
      `}</style>
    </Chapter>
  );
}
