import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, githubRepositories, repositoryTestCases } from "@/db";
import { renderBrowserScript } from "@/lib/render-browser-script";
import { callAgentService } from "@/lib/agent-service";
import { loadGithubRepositorySource, RepositorySourceError } from "@/lib/github-repository-source";

export const maxDuration = 300;
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth(); if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await context.params; const repoId = Number(id);
    if (!Number.isSafeInteger(repoId) || repoId < 1) return NextResponse.json({ error: "Invalid repository." }, { status: 400 });
    const [repo] = await db.select().from(githubRepositories).where(and(eq(githubRepositories.id, repoId), eq(githubRepositories.clerkUserId, userId))).limit(1);
    if (!repo) return NextResponse.json({ error: "Repository not found." }, { status: 404 });
    const testCases = await db.select().from(repositoryTestCases).where(and(eq(repositoryTestCases.repositoryId, repoId), eq(repositoryTestCases.clerkUserId, userId)));
    return NextResponse.json({ repository: repo, testCases: testCases.map((testCase) => ({
      ...testCase,
      browserbaseScript: renderBrowserScript(testCase.title, testCase.steps),
    })) });
  } catch (error) {
    console.error("Could not load repository test data", error);
    return NextResponse.json({ error: "Could not load repository test data. Check the server logs for details." }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const repositoryId = Number(id);
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) return NextResponse.json({ error: "Invalid repository." }, { status: 400 });

  try {
    const body = await request.json() as { applicationUrl?: unknown; featurePrompt?: unknown; testCaseCount?: unknown };
    if (typeof body.applicationUrl !== "string" || !body.applicationUrl.trim()) {
      return NextResponse.json({ error: "Enter the website URL before generating test cases." }, { status: 400 });
    }
    let applicationUrl: URL;
    try {
      applicationUrl = new URL(body.applicationUrl.trim());
    } catch {
      return NextResponse.json({ error: "Enter a valid website URL, such as https://example.com." }, { status: 400 });
    }
    if (!["http:", "https:"].includes(applicationUrl.protocol) || !applicationUrl.hostname || applicationUrl.username || applicationUrl.password) {
      return NextResponse.json({ error: "Use a valid http or https website URL without credentials." }, { status: 400 });
    }

    const featurePrompt = typeof body.featurePrompt === "string" ? body.featurePrompt.trim() : "";
    if (featurePrompt.length > 4000) return NextResponse.json({ error: "Keep the feature testing prompt under 4,000 characters." }, { status: 400 });
    const testCaseCount = body.testCaseCount === undefined ? 5 : body.testCaseCount;
    if (!Number.isInteger(testCaseCount) || (testCaseCount as number) < 1 || (testCaseCount as number) > 10) {
      return NextResponse.json({ error: "Choose between 1 and 10 test cases." }, { status: 400 });
    }

    const snapshot = await loadGithubRepositorySource(userId, repositoryId, featurePrompt);
    const result = await callAgentService<{ test_cases: Array<{ title: string; description: string; type: string; priority: string; targetRoute: string; targetFiles: string[]; expectedResult: string; steps: Array<{ action: string; selector?: string; value?: string }> }> }>("/v1/repositories/generate-tests", {
      clerk_user_id: userId,
      repository_id: snapshot.repo.id,
      repository_name: snapshot.repo.fullName,
      repository_branch: snapshot.repo.defaultBranch,
      application_url: applicationUrl.toString(),
      feature_prompt: featurePrompt,
      test_case_count: testCaseCount,
      commit_sha: snapshot.sha,
      change_summary: snapshot.changeSummary,
      changed_files: snapshot.changedFiles,
      files: snapshot.files,
    }, 300_000);

    if (!Array.isArray(result.test_cases) || result.test_cases.length === 0) {
      return NextResponse.json({ error: "No test cases could be grounded in the current repository source. Your existing cases were kept." }, { status: 422 });
    }

    await db.delete(repositoryTestCases).where(and(eq(repositoryTestCases.repositoryId, repositoryId), eq(repositoryTestCases.clerkUserId, userId)));
    const saved = await db.insert(repositoryTestCases).values(result.test_cases.map((test) => ({
      clerkUserId: userId,
      repositoryId,
      title: test.title.slice(0, 200),
      description: test.description.slice(0, 1200),
      type: test.type,
      priority: test.priority,
      targetRoute: test.targetRoute,
      targetFiles: test.targetFiles,
      expectedResult: test.expectedResult.slice(0, 1200),
      status: "draft",
      steps: test.steps,
      browserbaseScript: renderBrowserScript(test.title, test.steps),
    }))).returning();

    return NextResponse.json({ analyzedCommit: snapshot.sha, fileCount: snapshot.files.length, testCases: saved });
  } catch (error) {
    console.error("Test case generation failed", error);
    if (error instanceof RepositorySourceError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Test case generation failed." }, { status: 502 });
  }
}