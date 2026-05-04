# Local Postgres

Read when: replacing EmergentDB/Neon locally, running Lewis's MacBook as the Unbrowse storage server, or changing marketplace graph storage.

Unbrowse's provider-agnostic storage target is Postgres:

- `app_kv` keeps the existing KV contract used by `skillsKV` and `statsKV`.
- `endpoint_nodes` stores the endpoint manifest projection used by graph resolution.
- `endpoint_edges` stores DAG dependencies with bindings and confidence.
- `endpoint_embeddings` stores pgvector embeddings next to the source endpoint rows.
- `graph_namespaces` versions graph data so stale vector/edge sets can be abandoned cleanly.

Drizzle owns schema and migrations. The only custom SQL in the first migration is `CREATE EXTENSION IF NOT EXISTS vector`, because Drizzle's pgvector support expects the extension to exist before vector columns and HNSW indexes are created.

## Run on the MacBook

Install Docker Desktop or OrbStack first. This repo currently expects Docker Compose v2.

```bash
docker compose up -d postgres
docker compose --profile migrate run --rm postgres-migrate
```

Default local URL:

```bash
postgres://unbrowse:unbrowse_dev_password@127.0.0.1:5432/unbrowse
```

Use it with the backend:

```bash
DATABASE_URL=postgres://unbrowse:unbrowse_dev_password@127.0.0.1:5432/unbrowse \
  bun --cwd backend run dev
```

## Schema workflow

Change [backend/src/db/schema.ts](/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/backend/src/db/schema.ts), then generate and review a migration:

```bash
bun run db:generate --name=<short-name>
bunx drizzle-kit check
```

Apply migrations:

```bash
bun run db:migrate
```

For local iteration only, `bun run db:push` can push schema directly without migration files. Do not use `db:push` as the release path.

## Network

The compose file binds Postgres to `127.0.0.1` by default. To expose the MacBook on Tailscale or LAN, set:

```bash
UNBROWSE_POSTGRES_BIND=0.0.0.0 docker compose up -d postgres
```

Prefer Tailscale plus firewall rules before exposing Postgres to a broader network.
