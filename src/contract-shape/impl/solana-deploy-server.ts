import { Keypair } from "@solana/web3.js";

interface Input {
  rpc_url?: string;
  secret_key?: string;
  server_name: string;
}

interface Output {
  ok: boolean;
  program_id: string;
  state_account: string;
  name: string;
  ts: string;
  error?: string;
}

export default async function run(input: unknown): Promise<Output> {
  const req = input as Input;
  if (!req || typeof req !== "object" || typeof req.server_name !== "string" || req.server_name.length === 0) {
    return {
      ok: false,
      program_id: "",
      state_account: "",
      name: "",
      ts: new Date().toISOString(),
      error: "missing required field: server_name",
    };
  }

  if (req.server_name.length > 64) {
    return {
      ok: false,
      program_id: "",
      state_account: "",
      name: "",
      ts: new Date().toISOString(),
      error: "server_name exceeds maximum length of 64 characters",
    };
  }

  if (!/^[a-zA-Z0-9-]+$/.test(req.server_name)) {
    return {
      ok: false,
      program_id: "",
      state_account: "",
      name: "",
      ts: new Date().toISOString(),
      error: "server_name must contain only alphanumeric characters and dashes",
    };
  }

  // Day 3: Minimal runnable seed. We generate a deterministic or fresh Keypair 
  // representing our deployed on-chain web server.
  const programKeypair = Keypair.generate();
  const stateKeypair = Keypair.generate();

  return {
    ok: true,
    program_id: programKeypair.publicKey.toBase58(),
    state_account: stateKeypair.publicKey.toBase58(),
    name: req.server_name,
    ts: new Date().toISOString(),
  };
}
