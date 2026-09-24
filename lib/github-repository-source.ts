import { and, eq } from "drizzle-orm";
import { db, githubConnections, githubRepositories } from "@/db";
import { decryptGithubToken } from "@/lib/github-token";

const githubHeaders = (token: string) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "x-github-api-version": "2022-11-28",
});

const included = (path: string) => /(^|\/)(README|CHANGELOG|package\.json|Cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt|.*\.(tsx?|jsx?|py|go|rs|java|vue|svelte|md|css|scss|html))$/i.test(path)
  && !/(node_modules|dist|build|\.next|vendor|coverage|\.git)\//i.test(path);

export class RepositorySourceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "RepositorySourceError";
  }
}

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

export async function loadGithubRepositorySource(userId: string, repositoryId: number, featurePrompt = "") {
  const [repo] = await db.select().from(githubRepositories).where(and(
    eq(githubRepositories.id, repositoryId),
    eq(githubRepositories.clerkUserId, userId),
  )).limit(1);
  if (!repo) throw new RepositorySourceError("Repository not found.", 404);

  const [connection] = await db.select().from(githubConnections).where(eq(githubConnections.clerkUserId, userId)).limit(1);
  if (!connection) throw new RepositorySourceError("Reconnect GitHub to access this repository.", 409);
  const token = decryptGithubToken(connection.encryptedAccessToken);
  const headers = githubHeaders(token);

  const branch = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(repo.defaultBranch)}`, { headers, cache: "no-store" });
  if (!branch.ok) throw new Error("Could not read the repository's default branch.");
  const branchData = await branch.json() as { commit: { sha: string } };
  const sha = branchData.commit.sha;
  let changeSummary = "Initial baseline: inspect the current default-branch implementation and derive tests from its real pages, routes, components, and user-visible behavior.";
  const changedPaths = new Set<string>();

  if (repo.analyzedCommitSha && repo.analyzedCommitSha !== sha) {
    const compare = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/compare/${repo.analyzedCommitSha}...${sha}`, { headers, cache: "no-store" });
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
    changeSummary = "No repository changes since the previous analysis. Use the current source as evidence; do not claim code changed.";
  }

  const treeResponse = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${sha}?recursive=1`, { headers, cache: "no-store" });
  if (!treeResponse.ok) throw new Error("Could not read the repository file tree.");
  const tree = await treeResponse.json() as { tree: Array<{ path: string; type: string; size?: number }> };
  const candidates = tree.tree.filter((file) => file.type === "blob" && (file.size ?? 0) < 45_000 && included(file.path));
  const changed = candidates.filter((file) => changedPaths.has(file.path)).sort((a, b) => relevance(b.path, featurePrompt) - relevance(a.path, featurePrompt));
  const contextual = candidates.filter((file) => !changedPaths.has(file.path)).sort((a, b) => relevance(b.path, featurePrompt) - relevance(a.path, featurePrompt));
  const chosen = [...changed, ...contextual].slice(0, 36);
  const fetched = await Promise.all(chosen.map(async (file) => {
    try {
      const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`, { headers, cache: "no-store" });
      if (!response.ok) return null;
      const data = await response.json() as { content?: string; encoding?: string };
      return data.encoding === "base64" && data.content ? { path: file.path, content: Buffer.from(data.content, "base64").toString("utf8") } : null;
    } catch {
      return null;
    }
  }));

  const fetchedFiles = fetched.filter((file): file is { path: string; content: string } => file !== null);
  let remaining = 11_500;
  const files: Array<{ path: string; content: string }> = [];
  for (const file of fetchedFiles) {
    if (remaining <= 0) break;
    const header = `FILE ${file.path}\n`;
    const allowance = Math.min(file.content.length, remaining - header.length, files.length === 0 ? 7_000 : 4_000);
    if (allowance <= 0) continue;
    files.push({ path: file.path, content: file.content.slice(0, allowance) });
    remaining -= header.length + allowance + 2;
  }
  if (!files.length) throw new Error("No supported source files were found in this repository.");

  return {
    repo,
    sha,
    files,
    changeSummary: changeSummary.slice(0, 11_500),
    changedFiles: files.map((file) => file.path).filter((path) => changedPaths.has(path)),
  };
}
