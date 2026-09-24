import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, githubRepositories } from "@/db";
import { callAgentService } from "@/lib/agent-service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const repositoryId = Number(id);
  if (!Number.isSafeInteger(repositoryId)) return NextResponse.json({ error: "Invalid repository." }, { status: 400 });
  try {
    const [repo] = await db.select({ id: githubRepositories.id }).from(githubRepositories).where(and(eq(githubRepositories.id, repositoryId), eq(githubRepositories.clerkUserId, userId))).limit(1);
    if (!repo) return NextResponse.json({ error: "Repository not found." }, { status: 404 });
    const body = await request.json() as { question?: unknown; history?: Array<{ role: "user" | "assistant"; content: string }> };
    if (typeof body.question !== "string" || !body.question.trim() || body.question.length > 2000) return NextResponse.json({ error: "Enter a question under 2,000 characters." }, { status: 400 });
    const history = Array.isArray(body.history) ? body.history.filter((turn) => (turn.role === "user" || turn.role === "assistant") && typeof turn.content === "string").slice(-8) : [];
    const result = await callAgentService<{ answer: string; sources: string[] }>(`/v1/repositories/${repositoryId}/ask`, { clerk_user_id: userId, repository_id: repositoryId, question: body.question.trim(), history }, 90_000);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Repository RAG request failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not answer that question." }, { status: 502 });
  }
}
