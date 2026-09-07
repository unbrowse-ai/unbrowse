// Bun text-import of `.py` files (`import src from "./x.py" with { type: "text" }`).
// Bun inlines the file's contents as a string at build time, so python helpers can
// be BAKED INTO THE BUNDLE instead of shipped as sibling files that must be located
// on disk (and packaged in `files`). Used by src/env/kuri-proxy-bridge.ts.
declare module "*.py" {
  const content: string;
  export default content;
}
