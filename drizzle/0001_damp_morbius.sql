CREATE TABLE "provider_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"provider" text NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_knowledge" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"repository_id" integer NOT NULL,
	"path" text NOT NULL,
	"commit_sha" text NOT NULL,
	"content" text NOT NULL,
	"embedding" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_test_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"repository_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"steps" jsonb NOT NULL,
	"browserbase_script" text NOT NULL,
	"last_result" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_repositories" ADD COLUMN "analyzed_commit_sha" text;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_credentials_user_provider_unique" ON "provider_credentials" USING btree ("clerk_user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_knowledge_user_repo_path_unique" ON "repository_knowledge" USING btree ("clerk_user_id","repository_id","path");