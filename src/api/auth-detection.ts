// Auth-wall detection for /v1/browse/go.
//
// The browse pipeline runs a small JS probe inside the page after navigation
// and asks: is this page actually gated behind a sign-in, or does it just
// have a "Log In" link in the navbar like every public site on the web?
//
// Wrong answer here is expensive: a false-positive auto-opens a visible
// Chrome window (UNBROWSE_AUTO_AUTH path) and aborts the headless capture
// for a page the agent could have indexed cleanly. North-star: browser-open
// is failure mode, not feature.
//
// Signals that mean GATED:
//   - <input type="password"> visible on the page (real login form)
//   - Explicit gating copy ("please log in to continue", "you must be
//     signed in", "401 unauthorized", "403 forbidden")
//
// Signals that DO NOT mean gated (deliberately ignored):
//   - <a href="...login..."> in the navbar (every site has this)
//   - "Sign up" / "Log in" text anywhere in body (marketing, footer)
//   - Buttons with class="sign-in" (often present on public homepages)

export const AUTH_PROBE_JS = `JSON.stringify({
  hasPasswordInput: !!document.querySelector('input[type="password"]'),
  hasGateText: /please (log|sign)\\s*in to (continue|view|access)|sign\\s*in to continue|you must (log|sign)\\s*in|you (need|must) (be )?(logged|signed)\\s*in|401\\s+unauthorized|403\\s+forbidden|access denied/i.test(document.body.innerText || ''),
  url: location.href
})`;

export type AuthProbeResult = {
  hasPasswordInput: boolean;
  hasGateText: boolean;
  url: string;
};

export type AuthClassification = {
  required: boolean;
  reason: "password_input_present" | "gate_text_detected" | null;
};

export function classifyAuthSignals(info: AuthProbeResult): AuthClassification {
  if (info.hasPasswordInput) return { required: true, reason: "password_input_present" };
  if (info.hasGateText) return { required: true, reason: "gate_text_detected" };
  return { required: false, reason: null };
}
