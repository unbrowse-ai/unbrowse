declare module "*.wasm" {
  const value: WebAssembly.Module | Uint8Array | ArrayBuffer;
  export default value;
}
