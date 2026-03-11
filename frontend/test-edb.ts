const EBASE = "https://api.emergentdb.com";
const EMERGENTDB_API_KEY = "emdb_t2nmTrwHB6x2j7lJhe51GvmoG8bIS0Ii";
async function main() {
  const res = await fetch(`${EBASE}/vectors/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${EMERGENTDB_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ vector: Array(1536).fill(0), k: 5, include_metadata: true, namespace: "unbrowse-v2--global" }),
  });
  console.log(await res.json());
}
main();
