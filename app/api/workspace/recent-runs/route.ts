import { auth } from "@clerk/nextjs/server";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, githubRepositories, repositoryTestCases } from "@/db";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rows = await db.select({
    id: repositoryTestCases.id,
    title: repositoryTestCases.title,
    status: repositoryTestCases.status,
    lastResult: repositoryTestCases.lastResult,
    repositoryName: githubRepositories.fullName,
  }).from(repositoryTestCases)
    .innerJoin(githubRepositories, eq(repositoryTestCases.repositoryId, githubRepositories.id))
    .where(and(
      eq(repositoryTestCases.clerkUserId, userId),
      eq(githubRepositories.clerkUserId, userId),
      isNotNull(repositoryTestCases.lastResult),
    ))
    .orderBy(desc(repositoryTestCases.updatedAt))
    .limit(8);
  return NextResponse.json({ runs: rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    repositoryName: row.repositoryName,
    ranAt: row.lastResult?.ranAt ?? null,
    details: row.lastResult?.details ?? "",
    engine: row.lastResult?.engine ?? "",
  })) });
}
