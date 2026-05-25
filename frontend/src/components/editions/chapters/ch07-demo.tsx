import { Chapter } from "@/components/editions";
import { ChatDemo } from "@/components/chat-demo";
import { DemoParallax } from "@/components/demo-parallax";
import "./chapters.css";

/**
 * Chapter [07] Demo — Wave-2B port of §11 ChatDemo (Airbnb scripted chat)
 * onto the cream surface.
 *
 * ChatDemo is a 722-LOC self-contained dark-themed terminal — we VISUALLY
 * CONTAIN it inside `.ed-chat-demo-host`, a contained dark figure with a
 * cream-bordered outer margin, so cream is visible at the chapter edges.
 * No dark <section> bleed (SPEC §9 / project CLAUDE.md rule).
 *
 * The angel + saint-matthew CRT-filtered parallax stays inside the
 * dark host (does not bleed past chapter edges).
 */
export function Ch07Demo() {
  return (
    <Chapter
      id="demo"
      number="[07]"
      name="Demo"
      title="Example: airbnb.com"
      lede="One agent browses Airbnb. Every agent on the network can now search listings, check availability, and book — instantly, no browser."
    >
      <div className="ed-chat-demo-host">
        <DemoParallax />
        <ChatDemo />
      </div>
    </Chapter>
  );
}
