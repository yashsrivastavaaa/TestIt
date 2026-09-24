CREATE TABLE "github_connections" (
	"clerk_user_id" text PRIMARY KEY NOT NULL,
	"github_user_id" text NOT NULL,
	"github_login" text NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_repositories" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"github_repo_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"html_url" text NOT NULL,
	"description" text,
	"is_private" boolean DEFAULT false NOT NULL,
	"default_branch" text NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_repositories_user_repo_unique" ON "github_repositories" USING btree ("clerk_user_id","github_repo_id");