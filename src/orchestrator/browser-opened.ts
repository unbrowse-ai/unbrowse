export function browserOpenedFromSource(source: string): boolean {
  return (
    source === "live-capture" ||
    source === "dom-fallback" ||
    source === "browser-action" ||
    source === "browse-session" ||
    source === "first-pass"
  );
}
