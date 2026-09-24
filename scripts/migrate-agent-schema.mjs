import nextEnv from "@next/env";
import { neon } from "@neondatabase/serverless";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const sql = neon(process.env.DATABASE_URL);

// This idempotent upgrade supports databases whose original app tables were
// created earlier with drizzle-kit push (and therefore have no Drizzle journal).
await sql`CREATE EXTENSION IF NOT EXISTS vector`;
await sql`ALTER TABLE github_repositories ADD COLUMN IF NOT EXISTS analyzed_commit_sha text`;
await sql`CREATE TABLE IF NOT EXISTS repository_test_cases (
  id serial PRIMARY KEY,
  clerk_user_id text NOT NULL,
  repository_id integer NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  type text NOT NULL,
  status text DEFAULT 'draft' NOT NULL,
  steps jsonb NOT NULL,
  browserbase_script text NOT NULL,
  last_result jsonb,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
)`;
await sql`ALTER TABLE repository_test_cases ADD COLUMN IF NOT EXISTS priority text DEFAULT 'medium' NOT NULL`;
await sql`ALTER TABLE repository_test_cases ADD COLUMN IF NOT EXISTS target_route text DEFAULT '/' NOT NULL`;
await sql`ALTER TABLE repository_test_cases ADD COLUMN IF NOT EXISTS target_files jsonb DEFAULT '[]'::jsonb NOT NULL`;
await sql`ALTER TABLE repository_test_cases ADD COLUMN IF NOT EXISTS expected_result text DEFAULT '' NOT NULL`;
await sql`UPDATE repository_test_cases SET type = 'ui' WHERE type NOT IN ('ui', 'auth', 'api', 'form', 'integration', 'edge-case')`;
await sql`UPDATE repository_test_cases SET expected_result = description WHERE expected_result = ''`;
await sql`CREATE TABLE IF NOT EXISTS repository_knowledge (
  id serial PRIMARY KEY,
  clerk_user_id text NOT NULL,
  repository_id integer NOT NULL,
  path text NOT NULL,
  commit_sha text NOT NULL,
  content text NOT NULL,
  embedding vector(768) NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
)`;

const embeddingColumn = await sql`SELECT data_type FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'repository_knowledge' AND column_name = 'embedding'`;
if (embeddingColumn[0]?.data_type === "jsonb") {
  await sql`ALTER TABLE repository_knowledge ALTER COLUMN embedding TYPE vector(768)
    USING embedding::text::vector(768)`;
}
await sql`CREATE UNIQUE INDEX IF NOT EXISTS repository_knowledge_user_repo_path_unique
  ON repository_knowledge (clerk_user_id, repository_id, path)`;
await sql`CREATE INDEX IF NOT EXISTS repository_knowledge_scope_idx
  ON repository_knowledge (clerk_user_id, repository_id)`;
await sql`CREATE INDEX IF NOT EXISTS repository_knowledge_embedding_hnsw_idx
  ON repository_knowledge USING hnsw (embedding vector_cosine_ops)`;
await sql`CREATE INDEX IF NOT EXISTS repository_knowledge_content_search_idx
  ON repository_knowledge USING gin (to_tsvector('simple', path || ' ' || content))`;
console.log("Python agent tables and pgvector/full-text indexes are ready.");
