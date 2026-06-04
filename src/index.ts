import { config as loadEnv } from "dotenv";
import { installServerExitCleanup, startUnbrowseServer } from "./server.js";

loadEnv({ quiet: true });
loadEnv({ path: ".env.runtime", quiet: true });

const pidFile = process.env.UNBROWSE_PID_FILE;
installServerExitCleanup(pidFile);

const server = await startUnbrowseServer({
  pidFile,
  scheduleVerification: true,
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] ${signal} — closing browsers and server`);
  await server.close();
  process.exit(0);
}

process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });

console.log(`unbrowse running on http://${server.host}:${server.port}`);
