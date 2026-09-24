import { boolean, customType, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const vector768 = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(768)",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) => value.slice(1, -1).split(",").map(Number),
});

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name"),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const githubConnections = pgTable("github_connections", {
  clerkUserId: text("clerk_user_id").primaryKey(),
  githubUserId: text("github_user_id").notNull(),
  githubLogin: text("github_login").notNull(),
  encryptedAccessToken: text("encrypted_access_token").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const githubRepositories = pgTable("github_repositories", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull(),
  githubRepoId: text("github_repo_id").notNull(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  fullName: text("full_name").notNull(),
  htmlUrl: text("html_url").notNull(),
  description: text("description"),
  isPrivate: boolean("is_private").default(false).notNull(),
  defaultBranch: text("default_branch").notNull(),
  analyzedCommitSha: text("analyzed_commit_sha"),
  addedAt: timestamp("added_at").defaultNow().notNull(),
}, (table) => ({
  userRepoUnique: uniqueIndex("github_repositories_user_repo_unique").on(table.clerkUserId, table.githubRepoId),
}));

export const repositoryTestCases = pgTable("repository_test_cases", {
  id: serial("id").primaryKey(), clerkUserId: text("clerk_user_id").notNull(), repositoryId: integer("repository_id").notNull(), title: text("title").notNull(), description: text("description").notNull(), type: text("type").notNull(), priority: text("priority").notNull().default("medium"), targetRoute: text("target_route").notNull().default("/"), targetFiles: jsonb("target_files").$type<string[]>().notNull().default(sql`'[]'::jsonb`), expectedResult: text("expected_result").notNull().default(""), status: text("status").notNull().default("draft"), steps: jsonb("steps").$type<Array<{ action: string; value?: string; selector?: string }>>().notNull(), browserbaseScript: text("browserbase_script").notNull(), lastResult: jsonb("last_result").$type<{ passed: boolean; details: string; ranAt: string; engine?: string; sessionId?: string; failedStep?: number; currentUrl?: string; diagnosis?: string; confidence?: string; suggestedSteps?: Array<{ action: string; value?: string; selector?: string }> | null } | null>(), createdAt: timestamp("created_at").defaultNow().notNull(), updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const repositoryKnowledge = pgTable("repository_knowledge", {
  id: serial("id").primaryKey(), clerkUserId: text("clerk_user_id").notNull(), repositoryId: integer("repository_id").notNull(), path: text("path").notNull(), commitSha: text("commit_sha").notNull(), content: text("content").notNull(), embedding: vector768("embedding").notNull(), updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({ documentUnique: uniqueIndex("repository_knowledge_user_repo_path_unique").on(table.clerkUserId, table.repositoryId, table.path) }));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
