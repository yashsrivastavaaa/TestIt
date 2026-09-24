import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { callAgentService } from "@/lib/agent-service";

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json() as { question?: unknown; history?: Array<{ role: "user" | "assistant"; content: string }> };
    if (typeof body.question !== "string" || !body.question.trim() || body.question.length > 2000) {
      return NextResponse.json({ error: "Enter a question under 2,000 characters." }, { status: 400 });
    }
    const history = Array.isArray(body.history)
      ? body.history
          .filter((turn) => (turn.role === "user" || turn.role === "assistant") && typeof turn.content === "string")
          .slice(-8)
          .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 2000) }))
      : [];
    const result = await callAgentService<{ answer: string; sources: string[] }>("/v1/chat", {
      clerk_user_id: userId,
      question: body.question.trim(),
      history,
    }, 90_000);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Workspace chat failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not answer that question." }, { status: 502 });
  }
}
