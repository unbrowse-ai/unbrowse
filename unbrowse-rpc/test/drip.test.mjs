import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTransaction, recoverTransactionAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DRIP_WEI, LOW_WEI, DAILY_WEI, MIN_FEE_WEI, withheld, send, day, dripCost } from "../src/drip.js";

// Foundry's second public test account: a key nobody holds funds under.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

test("a member node is gassed once a network, when it holds little, within the day's budget", () => {
  assert.equal(withheld({ sentBefore: false, spentToday: 0n, balance: 0n }), null, "a new node holding nothing");
  assert.equal(withheld({ sentBefore: false, spentToday: 0n, balance: LOW_WEI - 1n }), null, "just under the line");
  assert.match(withheld({ sentBefore: false, spentToday: 0n, balance: LOW_WEI }), /holds enough/);
  assert.match(withheld({ sentBefore: true, spentToday: 0n, balance: 0n }), /already/);
  assert.equal(withheld({ sentBefore: false, spentToday: DAILY_WEI - DRIP_WEI, balance: 0n }), null, "the budget's last drip");
  assert.match(withheld({ sentBefore: false, spentToday: DAILY_WEI - DRIP_WEI + 1n, balance: 0n }), /budget/);
  assert.equal(day(86_400_000 * 3 + 5), 3);
});

test("a drip is the gas wallet's own signed transfer of the drip to the node, on the network's chain, at Arc's fee floor or more", async () => {
  const node = "0x1d4301D1EBca4e3b8EA5eb68201D21B096389422";
  const asked = [];
  let raw = null;
  const rpc = async (method, params) => {
    asked.push(method);
    if (method === "eth_getTransactionCount") return "0x7";
    if (method === "eth_gasPrice") return "0x2540be400"; // 10 gwei: under Arc's floor
    if (method === "eth_estimateGas") return "0x5208";
    if (method === "eth_sendRawTransaction") {
      raw = params[0];
      return "0x" + "ab".repeat(32);
    }
    throw new Error(method);
  };
  const tx = await send(rpc, KEY, 5042002, node, DRIP_WEI);
  assert.equal(tx, "0x" + "ab".repeat(32));
  assert.deepEqual(asked, ["eth_getTransactionCount", "eth_gasPrice", "eth_sendRawTransaction"]);
  const t = parseTransaction(raw);
  assert.equal(t.to.toLowerCase(), node.toLowerCase());
  assert.equal(t.value, DRIP_WEI);
  assert.equal(t.chainId, 5042002);
  assert.equal(t.nonce, 7);
  assert.equal(t.maxFeePerGas, MIN_FEE_WEI, "Arc drops anything under 20 gwei");
  assert.equal(t.gas, 21000n, "a plain value transfer");
  assert.equal(await recoverTransactionAddress({ serializedTransaction: raw }), privateKeyToAccount(KEY).address);
});

test("a drip spends no more gas than a plain transfer and counts that gas in the day's budget", async () => {
  const node = "0x1d4301D1EBca4e3b8EA5eb68201D21B096389422";
  let raw = null;
  const rpc = async (method, params) => {
    if (method === "eth_getTransactionCount") return "0x7";
    if (method === "eth_gasPrice") return "0x2540be400";
    if (method === "eth_estimateGas") return "0x4c4b40"; // a contract recipient that burns 5,000,000 gas
    if (method === "eth_sendRawTransaction") {
      raw = params[0];
      return "0x" + "ab".repeat(32);
    }
    throw new Error(method);
  };
  await send(rpc, KEY, 5042002, node, DRIP_WEI);
  const t = parseTransaction(raw);
  assert.equal(t.gas, 21000n, "a plain value transfer's gas, whatever a recipient would burn");
  const cost = DRIP_WEI + t.gas * t.maxFeePerGas;
  assert.equal(dripCost(t.maxFeePerGas), cost, "the drip and the most its gas can cost");
  assert.match(withheld({ sentBefore: false, spentToday: DAILY_WEI - DRIP_WEI, balance: 0n, cost }), /budget/, "the gas fee is spent from the day's budget too");
  assert.equal(withheld({ sentBefore: false, spentToday: DAILY_WEI - cost, balance: 0n, cost }), null);
});
