import { ACCOUNT_SCHEMA } from "../schemas.js";
import type { ToolDeps } from "./deps.js";

export function makeUnbrowseAccountTool(deps: ToolDeps) {
  const { indexClient, indexOpts } = deps;

  return {
    name: "unbrowse_account",
    label: "Account (Email Linking)",
    description:
      "Account funnel helper. Request an email to link your Solana wallet to your Unbrowse account " +
      "(so payouts + marketplace attribution can be managed under an email identity).",
    parameters: ACCOUNT_SCHEMA,
    async execute(_toolCallId: string, params: unknown) {
      const p = params as { action: "request_wallet_link"; email: string };

      try {
        if (p.action !== "request_wallet_link") {
          return { content: [{ type: "text", text: `Unknown action: ${String((p as any).action)}` }] };
        }
        const email = String(p.email ?? "").toLowerCase().trim();
        if (!email || !email.includes("@")) {
          return { content: [{ type: "text", text: "Provide a valid email." }] };
        }

        const res: any = await indexClient.requestWalletLink(email);
        const lines = [
          `Wallet link requested.`,
          `Email: ${email}`,
          res?.expiresAt ? `Expires: ${res.expiresAt}` : null,
          ``,
          `Check your inbox and click the confirmation link to finish linking.`,
          res?.dev?.linkUrl ? `` : null,
          res?.dev?.linkUrl ? `DEV: ${res.dev.linkUrl}` : null,
        ].filter(Boolean).join("\n");

        return { content: [{ type: "text", text: lines }] };
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        const hint = indexOpts?.indexUrl ? `Index: ${indexOpts.indexUrl}` : null;
        return { content: [{ type: "text", text: `Account action failed: ${msg}${hint ? `\n${hint}` : ""}` }] };
      }
    },
  };
}

