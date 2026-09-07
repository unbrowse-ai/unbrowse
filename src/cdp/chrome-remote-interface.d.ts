// Ambient shim — chrome-remote-interface ships no .d.ts. We statically import it
// (so the bundler inlines it into the runtime bundle; see connection.ts) and only
// need the default factory signature. Loose by design: the real CRI client is
// re-typed as CRIClient in connection.ts.
declare module "chrome-remote-interface" {
  const CDP: (opts: { target: string }) => Promise<unknown>;
  export default CDP;
}
