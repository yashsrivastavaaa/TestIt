import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db, githubConnections, githubRepositories } from "@/db";
import { decryptGithubToken } from "@/lib/github-token";

type GithubRepository = {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  owner: { login: string };
};

function githubHeaders(token: string) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
}

async function getConnection(userId: string) {
  const [connection] = await db.select().from(githubConnections)
    .where(eq(githubConnections.clerkUserId, userId)).limit(1);
  return connection;
}

export async function GET(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const requestedPage = Number(request.nextUrl.searchParams.get("page") || "1");
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const perPage = 10;

  try {
    const connection = await getConnection(userId);
    if (!connection) return NextResponse.json({ connected: false, repositories: [] });

    const token = decryptGithubToken(connection.encryptedAccessToken);
    const githubUrl = new URL("https://api.github.com/user/repos");
    githubUrl.search = new URLSearchParams({
      visibility: "all",
      affiliation: "owner,collaborator,organization_member",
      sort: "updated",
      per_page: String(perPage),
      page: String(page),
    }).toString();
    const response = await fetch(githubUrl, {
      headers: githubHeaders(token),
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 401) {
      await db.delete(githubConnections).where(eq(githubConnections.clerkUserId, userId));
      return NextResponse.json({ connected: false, error: "GitHub authorization expired. Reconnect your account." });
    }
    if (!response.ok) {
      return NextResponse.json({ error: "Could not load GitHub repositories." }, { status: 502 });
    }
    const repositories = await response.json() as GithubRepository[];

    const links = response.headers.get("link")?.split(",") ?? [];
    const getLinkedPage = (relation: string) => {
      const link = links.find((value) => value.includes(`rel="${relation}"`));
      const url = link?.match(/<([^>]+)>/)?.[1];
      const linkedPage = url ? new URL(url).searchParams.get("page") : null;
      return linkedPage ? Number(linkedPage) : null;
    };
    const totalPages = getLinkedPage("last");
    const hasPrevious = getLinkedPage("prev") !== null;
    const hasNext = getLinkedPage("next") !== null;

    const selected = await db.select()
      .from(githubRepositories)
      .where(eq(githubRepositories.clerkUserId, userId));
    const selectedIds = new Set(selected.map((repo) => repo.githubRepoId));

    return NextResponse.json({
      connected: true,
      account: connection.githubLogin,
      pagination: {
        page,
        perPage,
        totalPages: totalPages ?? (hasNext ? null : page),
        hasPrevious,
        hasNext,
      },
      addedRepositories: selected.map((repo) => ({
        workspaceId: repo.id,
        id: repo.githubRepoId,
        name: repo.name,
        fullName: repo.fullName,
        url: repo.htmlUrl,
        description: repo.description,
        isPrivate: repo.isPrivate,
        defaultBranch: repo.defaultBranch,
        added: true,
      })),
      repositories: repositories.map((repo) => ({
        id: String(repo.id),
        name: repo.name,
        fullName: repo.full_name,
        url: repo.html_url,
        description: repo.description,
        isPrivate: repo.private,
        defaultBranch: repo.default_branch,
        added: selectedIds.has(String(repo.id)),
      })),
    });
  } catch (error) {
    console.error("Could not load GitHub repositories:", error);
    if (error instanceof Error && error.name === "TimeoutError") return NextResponse.json({ error: "GitHub took too long to respond. Please retry." }, { status: 504 });
    const databaseCode = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (["42703", "42P01", "42704"].includes(databaseCode)) {
      return NextResponse.json({
        error: "The database schema is missing required GitHub or agent tables. Run `npm run db:migrate:agents` and retry.",
      }, { status: 503 });
    }
    return NextResponse.json({ error: "Could not load GitHub repositories." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json() as { repositoryId?: unknown };
    const repositoryId = typeof body.repositoryId === "string" ? body.repositoryId : String(body.repositoryId ?? "");
    if (!/^\d+$/.test(repositoryId)) {
      return NextResponse.json({ error: "A valid GitHub repository is required." }, { status: 400 });
    }

    const connection = await getConnection(userId);
    if (!connection) return NextResponse.json({ error: "Connect GitHub before adding a repository." }, { status: 409 });

    const token = decryptGithubToken(connection.encryptedAccessToken);
    const response = await fetch(`https://api.github.com/repositories/${repositoryId}`, {
      headers: githubHeaders(token),
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 404 || response.status === 401) {
      return NextResponse.json({ error: "This repository is not available to the connected GitHub account." }, { status: 404 });
    }
    if (!response.ok) return NextResponse.json({ error: "Could not verify this GitHub repository." }, { status: 502 });

    const repo = await response.json() as GithubRepository;
    const [saved] = await db.insert(githubRepositories).values({
      clerkUserId: userId,
      githubRepoId: String(repo.id),
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.full_name,
      htmlUrl: repo.html_url,
      description: repo.description,
      isPrivate: repo.private,
      defaultBranch: repo.default_branch || "main",
    }).onConflictDoUpdate({
      target: [githubRepositories.clerkUserId, githubRepositories.githubRepoId],
      set: {
        owner: repo.owner.login,
        name: repo.name,
        fullName: repo.full_name,
        htmlUrl: repo.html_url,
        description: repo.description,
        isPrivate: repo.private,
        defaultBranch: repo.default_branch || "main",
      },
    }).returning();

    return NextResponse.json({
      repository: {
        workspaceId: saved.id,
        id: saved.githubRepoId,
        name: saved.name,
        fullName: saved.fullName,
        url: saved.htmlUrl,
        description: saved.description,
        isPrivate: saved.isPrivate,
        defaultBranch: saved.defaultBranch,
        added: true,
      },
    }, { status: 201 });
  } catch (error) {
    console.error("Could not add GitHub repository:", error);
    if (error instanceof Error && error.name === "TimeoutError") return NextResponse.json({ error: "GitHub took too long to respond. Please retry." }, { status: 504 });
    return NextResponse.json({ error: "Could not add GitHub repository." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const repositoryId = request.nextUrl.searchParams.get("repositoryId");
  if (!repositoryId || !/^\d+$/.test(repositoryId)) {
    return NextResponse.json({ error: "A valid repository ID is required." }, { status: 400 });
  }

  await db.delete(githubRepositories).where(and(
    eq(githubRepositories.clerkUserId, userId),
    eq(githubRepositories.githubRepoId, repositoryId)
  ));
  return NextResponse.json({ success: true });
}
