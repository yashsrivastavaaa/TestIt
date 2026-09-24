CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
ALTER TABLE "repository_knowledge" ALTER COLUMN "embedding" SET DATA TYPE vector(768) USING "embedding"::text::vector(768);
--> statement-breakpoint
CREATE INDEX "repository_knowledge_scope_idx" ON "repository_knowledge" USING btree ("clerk_user_id", "repository_id");
--> statement-breakpoint
CREATE INDEX "repository_knowledge_embedding_hnsw_idx" ON "repository_knowledge" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX "repository_knowledge_content_search_idx" ON "repository_knowledge" USING gin (to_tsvector('simple', "path" || ' ' || "content"));
