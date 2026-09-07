// Ambient type for `.wasm` imports. The CLI's single-binary build (Bun) embeds
// the `.wasm` via the file loader and resolves the import to a path string at
// runtime; bundlers that pre-compile resolve it to a `WebAssembly.Module`.
// src/lib/core-wasm.ts handles both shapes defensively.
declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}
