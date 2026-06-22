// Ambient type for `.wasm` imports. Both wrangler/CF-Workers and bun resolve a
// `.wasm` import to a compiled `WebAssembly.Module` (CF) or fall back to a
// fetchable URL (bun). core-wasm.ts handles both shapes defensively.
declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}
