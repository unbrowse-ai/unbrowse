// The deployed entry: ./index.js's handler, with its database as the TelemetryStore Durable Object (./store.js).
// Every request reaches the same store, named "telemetry".

import { handle } from "./index.js";
import { client } from "./sql.js";
import QUERIES from "../queries.sql";

export { TelemetryStore } from "./store.js";

export default {
  fetch(request, env) {
    const store = env.STORE.get(env.STORE.idFromName("telemetry"));
    return handle(request, { ...env, TELEMETRY_DB: client(store), QUERIES });
  },
};
