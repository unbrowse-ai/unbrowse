import { saveWallet, isKeychainAvailable } from "./keychain-wallet.js";
import { generateBase58Keypair, keypairFromBase58PrivateKey } from "../solana/solana-helpers.js";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

export type WalletState = {
  creatorWallet?: string;
  solanaPrivateKey?: string;
};

export function createWalletTool(opts: {
  schema: unknown;
  logger: Logger;
  walletState: WalletState;
  // Kept separate for callers that pass these into other clients by reference.
  indexOpts: { creatorWallet?: string; solanaPrivateKey?: string };
}) {
  const { schema, logger, walletState, indexOpts } = opts;

  async function generateNewWallet(): Promise<{ publicKey: string; privateKeyB58: string }> {
    const { publicKey, privateKeyB58 } = await generateBase58Keypair();

    saveWallet({ creatorWallet: publicKey, solanaPrivateKey: privateKeyB58 });
    walletState.creatorWallet = publicKey;
    walletState.solanaPrivateKey = privateKeyB58;
    indexOpts.creatorWallet = publicKey;
    indexOpts.solanaPrivateKey = privateKeyB58;

    logger.info(
      `[unbrowse] Solana wallet created: ${publicKey}` +
        ` — send USDC (Solana SPL) to this address to download paid skills from the marketplace.` +
        ` You also earn USDC when others download your published skills.`,
    );

    return { publicKey, privateKeyB58 };
  }

  return {
    name: "unbrowse_wallet",
    label: "Wallet Setup",
    description:
      "Manage your Solana wallet for skill marketplace payments. " +
      "Check status, create a new keypair, or use an existing wallet. " +
      "The wallet earns USDC when others download your published skills, " +
      "and pays USDC to download paid skills from others.",
    parameters: schema,
    async execute(_toolCallId: string, params: unknown) {
      const p = params as { action?: string; wallet?: string; privateKey?: string };
      const action = p.action ?? "status";

      const creatorWallet = walletState.creatorWallet;
      const solanaPrivateKey = walletState.solanaPrivateKey;

      if (action === "create" || action === "setup") {
        if (creatorWallet && solanaPrivateKey) {
          return {
            content: [{
              type: "text",
              text:
                `Wallet already configured.\n` +
                `Creator (earning): ${creatorWallet}\n` +
                `Payer (spending): configured\n\n` +
                `Use action="status" to check balances, or use action="set_creator" to switch to a different wallet.`,
            }],
          };
        }

        try {
          const { publicKey } = await generateNewWallet();
          return {
            content: [{
              type: "text",
              text: [
                "Solana wallet generated and saved to config.",
                `Address: ${publicKey}`,
                "",
                "Fund this address with USDC to:",
                "  - Download paid skills from the marketplace",
                "  - Earn USDC when others download your published skills",
                "",
                "Send USDC (SPL) to this Solana address to get started.",
              ].join("\n"),
            }],
          };
        } catch (err) {
          return { content: [{ type: "text", text: `Wallet creation failed: ${(err as Error).message}` }] };
        }
      }

      if (action === "set_creator") {
        if (!p.wallet) {
          return { content: [{ type: "text", text: "Provide wallet= with a Solana address." }] };
        }
        try {
          saveWallet({ creatorWallet: p.wallet });
          walletState.creatorWallet = p.wallet;
          indexOpts.creatorWallet = p.wallet;
          return { content: [{ type: "text", text: `Creator wallet set: ${p.wallet}\nYou'll earn USDC when others download your published skills.` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Failed to save: ${(err as Error).message}` }] };
        }
      }

      if (action === "set_payer") {
        if (!p.privateKey) {
          return { content: [{ type: "text", text: "Provide privateKey= with a base58-encoded Solana private key." }] };
        }
        try {
          const keypair = await keypairFromBase58PrivateKey(p.privateKey);
          const publicKey = keypair.publicKey.toBase58();

          saveWallet({ solanaPrivateKey: p.privateKey });
          walletState.solanaPrivateKey = p.privateKey;
          indexOpts.solanaPrivateKey = p.privateKey;
          return {
            content: [{
              type: "text",
              text: `Payer wallet set: ${publicKey}\nThis wallet will be used to pay for skill downloads from the marketplace.`,
            }],
          };
        } catch (err) {
          return { content: [{ type: "text", text: `Invalid key or save failed: ${(err as Error).message}` }] };
        }
      }

      if (action === "export") {
        if (!solanaPrivateKey) {
          return { content: [{ type: "text", text: "No private key configured. Nothing to export." }] };
        }
        try {
          const keypair = await keypairFromBase58PrivateKey(solanaPrivateKey);
          return {
            content: [{
              type: "text",
              text: [
                "WALLET PRIVATE KEY - KEEP THIS SAFE!",
                "",
                `Address: ${keypair.publicKey.toBase58()}`,
                `Private Key: ${solanaPrivateKey}`,
                `Storage: ${isKeychainAvailable() ? "OS Keychain (encrypted)" : "~/.openclaw/unbrowse/wallet.json"}`,
                "",
                "SECURITY WARNINGS:",
                "  - Never share this private key with anyone",
                "  - Store it in a secure password manager",
                "  - Anyone with this key can drain your wallet",
                "  - Back this up BEFORE funding the wallet",
              ].join("\n"),
            }],
          };
        } catch (err) {
          return { content: [{ type: "text", text: `Export failed: ${(err as Error).message}` }] };
        }
      }

      // Default: status
      const lines = ["Unbrowse Wallet Status", ""];

      if (creatorWallet) lines.push(`Creator (earning): ${creatorWallet}`);
      else lines.push("Creator (earning): not configured");

      if (solanaPrivateKey) {
        const storage = isKeychainAvailable() ? "OS Keychain" : "wallet.json";
        try {
          const keypair = await keypairFromBase58PrivateKey(solanaPrivateKey);
          lines.push(`Payer (spending):  ${keypair.publicKey.toBase58()}`);
          lines.push(`  Storage: ${storage}`);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.includes("native") || msg.includes("NAPI") || msg.includes("napi")) {
            lines.push(`Payer (spending):  configured (native binding error — try Node v22 LTS)`);
          } else {
            lines.push("Payer (spending):  configured (key decode failed)");
          }
        }
      } else {
        lines.push("Payer (spending):  not configured");
      }

      lines.push("");

      if (!creatorWallet && !solanaPrivateKey) {
        lines.push(
          "No wallet configured. Choose one of the following options:",
          "",
          '  1. CREATE NEW WALLET: Use action="create" to generate a new Solana keypair',
          '     - This will create a brand new wallet just for you',
          "",
          '  2. USE EXISTING WALLET: Use action="set_creator" with wallet="YOUR_ADDRESS"',
          '     - Then use action="set_payer" with privateKey="YOUR_PRIVATE_KEY"',
          '     - Use this if you already have a Solana wallet with USDC',
          "",
          "The wallet is used to earn and pay USDC for skill marketplace access.",
        );
      } else if (!solanaPrivateKey) {
        lines.push(
          'No payer key configured.',
          "",
          '  Option 1: Use action="create" to generate a new keypair',
          '  Option 2: Use action="set_payer" with privateKey="YOUR_PRIVATE_KEY" to import existing',
          "",
          "A payer key is needed to download skills from the marketplace.",
        );
      } else if (!creatorWallet) {
        lines.push(
          'No creator wallet configured.',
          "",
          '  Use action="set_creator" with wallet="YOUR_ADDRESS" to set your earning address.',
          "",
          "A creator wallet lets you earn USDC when others download your skills.",
        );
      } else {
        lines.push(
          "Wallet ready. Fund the address with USDC to download paid skills.",
          "You earn USDC when others download your published skills.",
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  };
}
