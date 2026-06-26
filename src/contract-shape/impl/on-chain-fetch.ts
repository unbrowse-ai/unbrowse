import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

interface Input {
  program_id: string;
  state_account: string;
  path: string;
  params?: Record<string, string>;
}

interface Output {
  ok: boolean;
  status: number;
  body: string;
  signature: string;
  ts: string;
  error?: string;
}

export default async function run(input: unknown): Promise<Output> {
  const req = input as Input;
  if (!req || typeof req !== "object" || !req.program_id || !req.state_account || typeof req.path !== "string") {
    return {
      ok: false,
      status: 0,
      body: "",
      signature: "",
      ts: new Date().toISOString(),
      error: "missing required fields: program_id, state_account, path",
    };
  }

  // Base58 Solana public key shape validation (32-44 chars, alphanumeric)
  const isBase58 = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
  if (!isBase58(req.program_id)) {
    return {
      ok: false,
      status: 0,
      body: "",
      signature: "",
      ts: new Date().toISOString(),
      error: "invalid program_id format: must be a valid Solana public key",
    };
  }

  if (!isBase58(req.state_account)) {
    return {
      ok: false,
      status: 0,
      body: "",
      signature: "",
      ts: new Date().toISOString(),
      error: "invalid state_account format: must be a valid Solana public key",
    };
  }

  if (!req.path.startsWith("/")) {
    return {
      ok: false,
      status: 0,
      body: "",
      signature: "",
      ts: new Date().toISOString(),
      error: "path must start with a slash",
    };
  }

  if (req.path.includes("..")) {
    return {
      ok: false,
      status: 0,
      body: "",
      signature: "",
      ts: new Date().toISOString(),
      error: "directory traversal characters (..) are not allowed in path",
    };
  }

  // Day 3: Minimal runnable seed. Resolves simulated static router responses
  // from the simulated on-chain server program, and signs the returned body
  // off-chain (representing the server enclave signature).
  const routerPayload = {
    message: `Hello from on-chain unbrowse web server! Received path: ${req.path}`,
    resolved_at: new Date().toISOString(),
    program_id: req.program_id,
    state_account: req.state_account,
  };

  const bodyStr = JSON.stringify(routerPayload);
  const dummyEnclaveKeypair = Keypair.generate();
  const signatureBytes = nacl.sign.detached(
    new TextEncoder().encode(bodyStr),
    dummyEnclaveKeypair.secretKey
  );

  return {
    ok: true,
    status: 200,
    body: bodyStr,
    signature: Buffer.from(signatureBytes).toString("base64"),
    ts: new Date().toISOString(),
  };
}
