import { searchSkills } from "./src/lib/api";
async function main() {
  const res = await searchSkills("dexscreener");
  console.log(JSON.stringify(res, null, 2));
}
main();
