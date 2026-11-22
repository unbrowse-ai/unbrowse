// The one Durable Object that holds the events and the report counts, in its own SQLite, made from schema.sql.
// A batch runs in one transaction: kept whole or not at all, as D1's batch.

import { DurableObject } from "cloudflare:workers";
import SCHEMA from "../schema.sql";
import { execute, migrate } from "./sql.js";

export class TelemetryStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(SCHEMA);
      migrate((sql, ...v) => ctx.storage.sql.exec(sql, ...v));
    });
  }

  query(op) {
    return execute((sql, ...v) => this.ctx.storage.sql.exec(sql, ...v), op);
  }

  batch(ops) {
    return this.ctx.storage.transactionSync(() => ops.map((op) => this.query(op)));
  }
}
