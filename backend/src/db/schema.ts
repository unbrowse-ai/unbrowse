import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  vector,
} from "drizzle-orm/pg-core";

export const appKv = pgTable("app_kv", {
  namespace: text("namespace").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.namespace, table.key] }),
  index("app_kv_namespace_key_idx").on(table.namespace, table.key),
  index("app_kv_expires_at_idx").on(table.expiresAt),
]);

export const graphNamespaces = pgTable("graph_namespaces", {
  namespace: text("namespace").primaryKey(),
  storageBackend: text("storage_backend").notNull().default("postgres"),
  graphVersion: text("graph_version").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const endpointNodes = pgTable("endpoint_nodes", {
  namespace: text("namespace").notNull().references(() => graphNamespaces.namespace, { onDelete: "cascade" }),
  endpointId: text("endpoint_id").notNull(),
  skillId: text("skill_id").notNull(),
  domain: text("domain").notNull(),
  actionKind: text("action_kind"),
  resourceKind: text("resource_kind"),
  description: text("description"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  reliabilityScore: doublePrecision("reliability_score"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.namespace, table.endpointId] }),
  index("endpoint_nodes_skill_idx").on(table.skillId),
  index("endpoint_nodes_domain_idx").on(table.namespace, table.domain),
]);

export const endpointEdges = pgTable("endpoint_edges", {
  namespace: text("namespace").notNull().references(() => graphNamespaces.namespace, { onDelete: "cascade" }),
  fromEndpointId: text("from_endpoint_id").notNull(),
  toEndpointId: text("to_endpoint_id").notNull(),
  binding: text("binding").notNull(),
  edgeKind: text("edge_kind").notNull().default("requires"),
  confidence: doublePrecision("confidence").notNull().default(1),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.namespace, table.fromEndpointId, table.toEndpointId, table.binding] }),
  foreignKey({
    columns: [table.namespace, table.fromEndpointId],
    foreignColumns: [endpointNodes.namespace, endpointNodes.endpointId],
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.namespace, table.toEndpointId],
    foreignColumns: [endpointNodes.namespace, endpointNodes.endpointId],
  }).onDelete("cascade"),
  index("endpoint_edges_to_idx").on(table.namespace, table.toEndpointId),
  index("endpoint_edges_from_idx").on(table.namespace, table.fromEndpointId),
]);

export const endpointEmbeddings = pgTable("endpoint_embeddings", {
  namespace: text("namespace").notNull(),
  endpointId: text("endpoint_id").notNull(),
  embedding: vector("embedding", { dimensions: 1536 }),
  searchText: text("search_text").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.namespace, table.endpointId] }),
  foreignKey({
    columns: [table.namespace, table.endpointId],
    foreignColumns: [endpointNodes.namespace, endpointNodes.endpointId],
  }).onDelete("cascade"),
  index("endpoint_embeddings_hnsw_idx").using("hnsw", sql`${table.embedding} vector_cosine_ops`),
]);
