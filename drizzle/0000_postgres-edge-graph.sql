CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_kv" (
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_kv_namespace_key_pk" PRIMARY KEY("namespace","key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_edges" (
	"namespace" text NOT NULL,
	"from_endpoint_id" text NOT NULL,
	"to_endpoint_id" text NOT NULL,
	"binding" text NOT NULL,
	"edge_kind" text DEFAULT 'requires' NOT NULL,
	"confidence" double precision DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "endpoint_edges_namespace_from_endpoint_id_to_endpoint_id_binding_pk" PRIMARY KEY("namespace","from_endpoint_id","to_endpoint_id","binding")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_embeddings" (
	"namespace" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"embedding" vector(1536),
	"search_text" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "endpoint_embeddings_namespace_endpoint_id_pk" PRIMARY KEY("namespace","endpoint_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_nodes" (
	"namespace" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"domain" text NOT NULL,
	"action_kind" text,
	"resource_kind" text,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reliability_score" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "endpoint_nodes_namespace_endpoint_id_pk" PRIMARY KEY("namespace","endpoint_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "graph_namespaces" (
	"namespace" text PRIMARY KEY NOT NULL,
	"storage_backend" text DEFAULT 'postgres' NOT NULL,
	"graph_version" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "endpoint_edges" ADD CONSTRAINT "endpoint_edges_namespace_graph_namespaces_namespace_fk" FOREIGN KEY ("namespace") REFERENCES "public"."graph_namespaces"("namespace") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "endpoint_edges" ADD CONSTRAINT "endpoint_edges_namespace_from_endpoint_id_endpoint_nodes_namespace_endpoint_id_fk" FOREIGN KEY ("namespace","from_endpoint_id") REFERENCES "public"."endpoint_nodes"("namespace","endpoint_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "endpoint_edges" ADD CONSTRAINT "endpoint_edges_namespace_to_endpoint_id_endpoint_nodes_namespace_endpoint_id_fk" FOREIGN KEY ("namespace","to_endpoint_id") REFERENCES "public"."endpoint_nodes"("namespace","endpoint_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "endpoint_embeddings" ADD CONSTRAINT "endpoint_embeddings_namespace_endpoint_id_endpoint_nodes_namespace_endpoint_id_fk" FOREIGN KEY ("namespace","endpoint_id") REFERENCES "public"."endpoint_nodes"("namespace","endpoint_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "endpoint_nodes" ADD CONSTRAINT "endpoint_nodes_namespace_graph_namespaces_namespace_fk" FOREIGN KEY ("namespace") REFERENCES "public"."graph_namespaces"("namespace") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_kv_namespace_key_idx" ON "app_kv" USING btree ("namespace","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_kv_expires_at_idx" ON "app_kv" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_edges_to_idx" ON "endpoint_edges" USING btree ("namespace","to_endpoint_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_edges_from_idx" ON "endpoint_edges" USING btree ("namespace","from_endpoint_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_embeddings_hnsw_idx" ON "endpoint_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_nodes_skill_idx" ON "endpoint_nodes" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_nodes_domain_idx" ON "endpoint_nodes" USING btree ("namespace","domain");
