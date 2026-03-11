import "dotenv/config";
import fs from "fs";

const EBASE = "https://api.emergentdb.com";
const key = fs.readFileSync("../backend/.dev.vars", "utf8").split("\n").find(l => l.startsWith("EMERGENTDB_API_KEY="))!.split("=")[1];

async function main() {
  const res = await fetch(`${EBASE}/vectors/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ vector: Array(1536).fill(0), k: 5, include_metadata: true, namespace: "unbrowse-v2--global" }),
  });
  console.log(await res.json());
}
main();
