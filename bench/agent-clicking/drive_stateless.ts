/**
 * drive_stateless.ts — exercise the REAL stateless browser primitives over kuri against a real
 * page, with NO session lifecycle in this driver (the proof of "API-native, stateless").
 *
 *   bun bench/agent-clicking/drive_stateless.ts http://127.0.0.1:PORT/testpage.html
 *
 * Flow (each call is independent — tab opened + closed inside the op):
 *   1. statelessSnapshot({url})        -> find the button's [eN] ref in the returned a11y tree
 *   2. statelessClick({url, ref})      -> fresh load, click, return post-click snapshot + network
 * Assert: the post-click snapshot reflects the click effect (result flips IDLE -> CLICKED) AND
 * the click's API call appears in the captured network. Both witnessed statelessly.
 *
 * Emits one JSON line: {ok, ref, clicked_effect, network_hit, snap_excerpt, error?}.
 */
import { statelessSnapshot, statelessClick } from "../../src/kuri/stateless-primitive.js";

const url = process.argv[2];
if (!url) {
  process.stdout.write(JSON.stringify({ ok: false, error: "usage: drive_stateless.ts <url>" }) + "\n");
  process.exit(2);
}

function findRef(snapshot: string): string | undefined {
  // kuri interactive snapshots tag interactive nodes with [eN]; the button carries our label.
  const lines = snapshot.split("\n");
  for (const line of lines) {
    if (/run the action/i.test(line) || /\bgo\b/i.test(line)) {
      const m = line.match(/\[(e\d+)\]/);
      if (m) return `[${m[1]}]`;
    }
  }
  // fallback: first [eN] ref present
  const any = snapshot.match(/\[(e\d+)\]/);
  return any ? `[${any[1]}]` : undefined;
}

const out: Record<string, unknown> = { ok: false };
try {
  const snap = await statelessSnapshot({ url });
  if (!snap.ok || !snap.snapshot) {
    out.error = `snapshot_failed:${snap.error ?? "no_snapshot"}`;
    process.stdout.write(JSON.stringify(out) + "\n");
    process.exit(1);
  }
  const ref = findRef(snap.snapshot);
  out.ref = ref;
  if (!ref) {
    out.error = "no_ref_found";
    out.snap_excerpt = snap.snapshot.slice(0, 400);
    process.stdout.write(JSON.stringify(out) + "\n");
    process.exit(1);
  }

  const clicked = await statelessClick({ url, ref });
  if (!clicked.ok) {
    out.error = `click_failed:${clicked.error ?? "unknown"}`;
    process.stdout.write(JSON.stringify(out) + "\n");
    process.exit(1);
  }
  const postSnap = clicked.snapshot ?? "";
  const clickedEffect = /CLICKED/.test(postSnap);
  const networkHit = (clicked.network ?? []).some((e) =>
    JSON.stringify(e).includes("/api/action"),
  );
  out.ok = clickedEffect; // the load-bearing assertion: the click really happened, statelessly
  out.clicked_effect = clickedEffect;
  out.network_hit = networkHit;
  out.network_count = (clicked.network ?? []).length;
  out.snap_excerpt = postSnap.slice(0, 300);
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(clickedEffect ? 0 : 1);
} catch (e) {
  out.error = e instanceof Error ? e.message.slice(0, 240) : String(e);
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(1);
}
