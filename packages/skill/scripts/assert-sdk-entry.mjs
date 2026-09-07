#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const entry = resolve(import.meta.dirname, "..", "dist-sdk", "sdk", "index.js");
const sdk = await import(pathToFileURL(entry).href);
if (typeof sdk.createHole !== "function") throw new Error("built unbrowse/sdk is missing createHole");
if (typeof sdk.mergedAuthHeaders !== "function") throw new Error("built unbrowse/sdk is missing mergedAuthHeaders");
sdk.createHole(); // the published zero-argument quickstart must construct without credentials
console.log("[sdk-entry] built unbrowse/sdk exports createHole + mergedAuthHeaders");
