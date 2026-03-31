export interface WalletProvider {
  name: string;
  connect(): Promise<{ address: string }>;
  disconnect(): Promise<void>;
  signTransaction(tx: unknown): Promise<string>;
  getBalance(): Promise<bigint>;
}

/**
 * Stub wallet provider — placeholder until Lobster/Corbits integration ships (#33).
 */
export class StubWalletProvider implements WalletProvider {
  name = "stub";
  async connect() { return { address: "0x0000000000000000000000000000000000000000" }; }
  async disconnect() {}
  async signTransaction(_tx: unknown) { return "0xsig"; }
  async getBalance() { return BigInt(0); }
}
