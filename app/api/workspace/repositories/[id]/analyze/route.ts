import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, githubRepositories } from "@/db";
import { callAgentService } from "@/lib/agent-service";
import { loadGithubRepositorySource, RepositorySourceError } from "@/lib/github-repository-source";

export const maxDuration = 300;

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const repositoryId = Number(id);
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) return NextResponse.json({ error: "Invalid repository." }, { status: 400 });

  try {
    const snapshot = await loadGithubRepositorySource(userId, repositoryId);
    const result = await callAgentService<{ indexed_chunks: number }>("/v1/repositories/analyze", {
      clerk_user_id: userId,
      repository_id: snapshot.repo.id,
      repository_name: snapshot.repo.fullName,
      repository_branch: snapshot.repo.defaultBranch,
      commit_sha: snapshot.sha,
      change_summary: snapshot.changeSummary,
      changed_files: snapshot.changedFiles,
      files: snapshot.files,
    }, 300_000);

    await db.update(githubRepositories)
      .set({ analyzedCommitSha: snapshot.sha })
      .where(and(eq(githubRepositories.id, repositoryId), eq(githubRepositories.clerkUserId, userId)));

    return NextResponse.json({
      analyzedCommit: snapshot.sha,
      fileCount: snapshot.files.length,
      indexedChunks: result.indexed_chunks,
    });
  } catch (error) {
    console.error("Repository source analysis failed", error);
    if (error instanceof RepositorySourceError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Repository analysis failed." }, { status: 502 });
  }
}
