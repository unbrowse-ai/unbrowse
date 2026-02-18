import { keypairFromBase58PrivateKey } from "@getfoundry/unbrowse-core";

function escapeForDoubleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function isPayerPrivateKeyValid(privateKey?: string | null): Promise<boolean> {
  if (!privateKey) return false;
  try {
    await keypairFromBase58PrivateKey(privateKey);
    return true;
  } catch {
    return false;
  }
}

export function buildPublishPromptLines(opts: {
  service: string;
  skillsDir?: string;
  hasCreatorWallet: boolean;
  hasPayerKey: boolean;
  payerKeyValid?: boolean;
}): string[] {
  const service = escapeForDoubleQuotes(opts.service);
  const skillsDirArg = opts.skillsDir
    ? ` skillsDir="${escapeForDoubleQuotes(opts.skillsDir)}"`
    : "";
  const publishCommand = `unbrowse_publish service="${service}"${skillsDirArg} price="0"`;
  const keyInvalid = opts.hasPayerKey && opts.payerKeyValid === false;

  if (!opts.hasCreatorWallet || !opts.hasPayerKey || keyInvalid) {
    const keyHint = keyInvalid
      ? [
          "Detected issue: payer private key is invalid/corrupted.",
          '  Fix:   unbrowse_wallet action="set_payer" privateKey="<base58-private-key>"',
          '  Or:    unbrowse_wallet action="create"',
        ]
      : [];
    return [
      "Publish ready, but wallet is missing or invalid.",
      '  Setup: unbrowse_wallet action="create"',
      '  Or:   unbrowse_wallet action="set_creator" wallet="<your-solana-address>"',
      '        unbrowse_wallet action="set_payer" privateKey="<base58-private-key>"',
      ...keyHint,
      `After wallet setup, publish now? Run: ${publishCommand}`,
    ];
  }

  return [
    `Publish now? Run: ${publishCommand}`,
  ];
}
