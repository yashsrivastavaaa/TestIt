import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db, githubConnections, githubRepositories, repositoryTestCases } from "@/db";
import { decryptGithubToken } from "@/lib/github-token";
import { renderBrowserScript } from "@/lib/render-browser-script";
import { callAgentService } from "@/lib/agent-service";
import { and, eq } from "drizzle-orm";

export const maxDuration = 300;
const headers = (token: string) => ({ accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" });
const included = (path: string) => /(^|\/)(README|CHANGELOG|package\.json|Cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt|.*\.(tsx?|jsx?|py|go|rs|java|vue|svelte|md|css|scss|html))$/i.test(path) && !/(node_modules|dist|build|\.next|vendor|coverage|\.git)\//i.test(path);

function relevance(path: string, featurePrompt: string) {
  const normalized = path.toLowerCase();
  const terms = featurePrompt.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? [];
  const nameScore = terms.reduce((score, term) => score + (normalized.includes(term) ? 4 : 0), 0);
  const implementationScore = /(^|\/)(app|src|pages|routes|components|tests?|e2e)(\/|$)/i.test(path) ? 3 : 0;
  const configScore = /(^|\/)(package\.json|readme\.md|.*config\.[^/]+)$/i.test(path) ? 1 : 0;
  const rootEntryScore = /(^|\/)(app\/page\.[^/]+|pages\/(index|_app)\.[^/]+|src\/app\/page\.[^/]+|src\/pages\/(index|_app)\.[^/]+|index\.html)$/i.test(path) ? (terms.length ? 6 : 24) : 0;
  const publicPageScore = /(^|\/)(app|pages)\/[^/]+\/page\.[^/]+$/i.test(path) ? (terms.length ? 3 : 8) : 0;
  const peripheralPenalty = /(^|\/)(admin|internal|api)(\/|$)/i.test(path) && !terms.some((term) => normalized.includes(term)) ? 5 : 0;
  return nameScore + implementationScore + configScore + rootEntryScore + publicPageScore - peripheralPenalty;
}

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
  const { userId } = await auth(); if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params; const repoId = Number(id);
  if (!Number.isSafeInteger(repoId)) return NextResponse.json({ error: "Invalid repository." }, { status: 400 });
  try {
    const body = await request.json() as { applicationUrl?: unknown; featurePrompt?: unknown; testCaseCount?: unknown };
    if (typeof body.applicationUrl !== "string") return NextResponse.json({ error: "Enter the website URL you want to test." }, { status: 400 });
    let applicationUrl: URL;
    try { applicationUrl = new URL(body.applicationUrl); } catch { return NextResponse.json({ error: "Enter a valid website URL, such as https://example.com." }, { status: 400 }); }
    if (!["http:", "https:"].includes(applicationUrl.protocol) || !applicationUrl.hostname || applicationUrl.username || applicationUrl.password) {
      return NextResponse.json({ error: "Use a valid http or https website URL without embedded credentials." }, { status: 400 });
    }
    const featurePrompt = typeof body.featurePrompt === "string" ? body.featurePrompt.trim() : "";
    if (featurePrompt.length > 4000) return NextResponse.json({ error: "Keep the feature testing prompt under 4,000 characters." }, { status: 400 });
    const testCaseCount = body.testCaseCount === undefined ? 5 : body.testCaseCount;
    if (!Number.isInteger(testCaseCount) || (testCaseCount as number) < 1 || (testCaseCount as number) > 10) {
      return NextResponse.json({ error: "Choose between 1 and 10 test cases." }, { status: 400 });
    }
    const [repo] = await db.select().from(githubRepositories).where(and(eq(githubRepositories.id, repoId), eq(githubRepositories.clerkUserId, userId))).limit(1);
    if (!repo) return NextResponse.json({ error: "Repository not found." }, { status: 404 });
    const [connection] = await db.select().from(githubConnections).where(eq(githubConnections.clerkUserId, userId)).limit(1);
    if (!connection) return NextResponse.json({ error: "Reconnect GitHub to analyze this repository." }, { status: 409 });
    const token = decryptGithubToken(connection.encryptedAccessToken);
    const branch = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(repo.defaultBranch)}`, { headers: headers(token), cache: "no-store" });
    if (!branch.ok) throw new Error("Could not read the repository's default branch.");
    const branchData = await branch.json() as { commit: { sha: string } }; const sha = branchData.commit.sha;
    let changeSummary = "Initial baseline: inspect the current default-branch implementation and derive tests from its real pages, routes, components, and user-visible behavior.";
    const changedPaths = new Set<string>();
    if (repo.analyzedCommitSha && repo.analyzedCommitSha !== sha) {
      const compare = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/compare/${repo.analyzedCommitSha}...${sha}`, { headers: headers(token), cache: "no-store" });
      if (compare.ok) {
        const data = await compare.json() as { files?: Array<{ filename: string; status: string; patch?: string }> };
        const changes = data.files ?? [];
        for (const file of changes) if (file.status !== "removed") changedPaths.add(file.filename);
        const detail = changes.slice(0, 50).map((file) => `${file.status}: ${file.filename}${file.patch ? `\n${file.patch.slice(0, 700)}` : ""}`).join("\n\n");
        changeSummary = `Changes from analyzed commit ${repo.analyzedCommitSha} to ${sha}. Prioritize behavior in changed files and verify it against the current source.\n${detail || "GitHub reported no file-level changes."}`;
      } else {
        changeSummary = `The previous analyzed commit (${repo.analyzedCommitSha}) is not comparable with the current branch (${sha}), possibly due to rewritten history. Treat this as a fresh baseline and inspect current source.`;
      }
    } else if (repo.analyzedCommitSha === sha) {
      changeSummary = "No repository changes since the previous analysis. Use the current source as evidence and honor the requested feature prompt; do not claim code changed.";
    }
    const treeResponse = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${sha}?recursive=1`, { headers: headers(token), cache: "no-store" });
    if (!treeResponse.ok) throw new Error("Could not read the repository file tree.");
    const tree = await treeResponse.json() as { tree: Array<{ path: string; type: string; size?: number }> };
    const candidates = tree.tree.filter((file) => file.type === "blob" && (file.size ?? 0) < 45_000 && included(file.path));
    const changed = candidates.filter((file) => changedPaths.has(file.path)).sort((a, b) => relevance(b.path, featurePrompt) - relevance(a.path, featurePrompt));
    const contextual = candidates.filter((file) => !changedPaths.has(file.path)).sort((a, b) => relevance(b.path, featurePrompt) - relevance(a.path, featurePrompt));
    const chosen = [...changed, ...contextual].slice(0, 36);
    const fetched = await Promise.all(chosen.map(async (file) => {
      try {
        const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`, { headers: headers(token), cache: "no-store" });
        if (!response.ok) return null;
        const data = await response.json() as { content?: string; encoding?: string };
        return data.encoding === "base64" && data.content ? { path: file.path, content: Buffer.from(data.content, "base64").toString("utf8") } : null;
      } catch { return null; }
    }));
    const allFiles = fetched.filter((file): file is { path: string; content: string } => file !== null);
    // The Python planner currently has a 12k character source budget. Reserve
    // most of it for changed source so alphabetical/context files cannot crowd it out.
    let remaining = 11_500;
    const files: Array<{ path: string; content: string }> = [];
    for (const file of allFiles) {
      if (remaining <= 0) break;
      const header = `FILE ${file.path}\n`;
      const allowance = Math.min(file.content.length, remaining - header.length, files.length === 0 ? 7_000 : 4_000);
      if (allowance <= 0) continue;
      files.push({ path: file.path, content: file.content.slice(0, allowance) });
      remaining -= header.length + allowance + 2;
    }
    if (!files.length) throw new Error("No supported source files were found in this repository.");
    const result = await callAgentService<{ test_cases: Array<{ title: string; description: string; type: string; priority: string; targetRoute: string; targetFiles: string[]; expectedResult: string; steps: Array<{ action: string; selector?: string; value?: string }> }>; indexed_chunks: number }>("/v1/repositories/analyze", {
      clerk_user_id: userId, repository_id: repo.id, repository_name: repo.fullName, repository_branch: repo.defaultBranch, application_url: applicationUrl.toString(), feature_prompt: featurePrompt, test_case_count: testCaseCount, commit_sha: sha, change_summary: changeSummary, changed_files: files.map((file) => file.path).filter((path) => changedPaths.has(path)),
      files: files.map((file) => ({ path: file.path, content: file.content })),
    }, 300_000);
    if (!Array.isArray(result.test_cases) || result.test_cases.length === 0) {
      return NextResponse.json({ error: "Analysis returned no test cases. Your existing cases were kept. Choose a feature supported by the repository code and analyze again." }, { status: 422 });
    }
    await db.delete(repositoryTestCases).where(and(eq(repositoryTestCases.repositoryId, repo.id), eq(repositoryTestCases.clerkUserId, userId)));
    const saved = await db.insert(repositoryTestCases).values(result.test_cases.map((test) => ({ clerkUserId: userId, repositoryId: repo.id, title: test.title.slice(0, 200), description: test.description.slice(0, 1200), type: test.type, priority: test.priority, targetRoute: test.targetRoute, targetFiles: test.targetFiles, expectedResult: test.expectedResult.slice(0, 1200), status: "draft", steps: test.steps, browserbaseScript: renderBrowserScript(test.title, test.steps) }))).returning();
    await db.update(githubRepositories).set({ analyzedCommitSha: sha }).where(and(eq(githubRepositories.id, repo.id), eq(githubRepositories.clerkUserId, userId)));
    return NextResponse.json({ analyzedCommit: sha, fileCount: files.length, indexedChunks: result.indexed_chunks, testCases: saved });
  } catch (error) { console.error("Repository analysis failed", error); return NextResponse.json({ error: error instanceof Error ? error.message : "Repository analysis failed." }, { status: 502 }); }
}
