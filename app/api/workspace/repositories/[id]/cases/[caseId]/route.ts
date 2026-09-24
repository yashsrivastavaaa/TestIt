import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db, githubRepositories, repositoryTestCases } from "@/db";
import { renderBrowserScript } from "@/lib/render-browser-script";
import { callAgentService } from "@/lib/agent-service";

type PlannedStep = { action: "navigate" | "click" | "fill" | "assertText" | "wait" | "setViewport"; selector?: string; value?: string };
export const maxDuration = 300;
const scopedCase = (userId: string, repoId: number, caseId: number) => and(eq(repositoryTestCases.clerkUserId, userId), eq(repositoryTestCases.repositoryId, repoId), eq(repositoryTestCases.id, caseId));
export async function GET(_request: Request, context: { params: Promise<{ id: string; caseId: string }> }) {
  const { userId } = await auth(); if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, caseId } = await context.params; const [testCase] = await db.select().from(repositoryTestCases).where(scopedCase(userId, Number(id), Number(caseId))).limit(1);
  return testCase ? NextResponse.json({ testCase }) : NextResponse.json({ error: "Test case not found." }, { status: 404 });
}
export async function PUT(request: NextRequest, context: { params: Promise<{ id: string; caseId: string }> }) {
  const { userId } = await auth(); if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, caseId } = await context.params;
  try {
    const body = await request.json() as { title?: string; description?: string; type?: string; priority?: string; targetRoute?: string; targetFiles?: string[]; expectedResult?: string; steps?: PlannedStep[] };
    const testTypes = ["ui", "auth", "api", "form", "integration", "edge-case"];
    const priorities = ["low", "medium", "high"];
    if (!body.title?.trim() || !body.description?.trim() || !body.type || !testTypes.includes(body.type) || !body.priority || !priorities.includes(body.priority) || !body.targetRoute?.startsWith("/") || !Array.isArray(body.targetFiles) || body.targetFiles.length > 20 || body.targetFiles.some((path) => typeof path !== "string") || !Array.isArray(body.steps) || body.steps.length > 30 || body.steps.some((step) => !["navigate", "click", "fill", "assertText", "wait", "setViewport"].includes(step.action))) return NextResponse.json({ error: "Add valid case metadata and test steps." }, { status: 400 });
    const existing = await db.select().from(repositoryTestCases).where(scopedCase(userId, Number(id), Number(caseId))).limit(1); if (!existing[0]) return NextResponse.json({ error: "Test case not found." }, { status: 404 });
    const [testCase] = await db.update(repositoryTestCases).set({ title: body.title.trim(), description: body.description.trim(), type: body.type, priority: body.priority, targetRoute: body.targetRoute, targetFiles: body.targetFiles, expectedResult: (body.expectedResult || body.description).trim(), steps: body.steps, browserbaseScript: renderBrowserScript(body.title.trim(), body.steps), status: "draft", lastResult: null, updatedAt: new Date() }).where(scopedCase(userId, Number(id), Number(caseId))).returning();
    return NextResponse.json({ testCase });
  } catch (error) { console.error("Could not update test case", error); return NextResponse.json({ error: "Could not update test case." }, { status: 500 }); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string; caseId: string }> }) {
  const { userId } = await auth(); if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, caseId } = await context.params; const repoId = Number(id); const rowId = Number(caseId);
  try {
    const body = await request.json().catch(() => ({})) as { applicationUrl?: unknown; useBrowserbase?: unknown; showBrowser?: unknown };
    if (typeof body.applicationUrl !== "string") return NextResponse.json({ error: "Enter the website URL before running this test." }, { status: 400 });
    let applicationUrl: URL;
    try { applicationUrl = new URL(body.applicationUrl); } catch { return NextResponse.json({ error: "Enter a valid website URL, such as https://example.com." }, { status: 400 }); }
    if (!["http:", "https:"].includes(applicationUrl.protocol) || !applicationUrl.hostname || applicationUrl.username || applicationUrl.password) {
      return NextResponse.json({ error: "Use a valid http or https website URL without embedded credentials." }, { status: 400 });
    }
    const useBrowserbase = body.useBrowserbase === true;
    const showBrowser = !useBrowserbase && body.showBrowser !== false;
    const [testCase] = await db.select().from(repositoryTestCases).where(scopedCase(userId, repoId, rowId)).limit(1); const [repo] = await db.select().from(githubRepositories).where(and(eq(githubRepositories.id, repoId), eq(githubRepositories.clerkUserId, userId))).limit(1);
    if (!testCase || !repo) return NextResponse.json({ error: "Test case or repository not found." }, { status: 404 });
    const response = await callAgentService<{ result: { passed: boolean; details: string; ranAt: string; engine?: string; sessionId?: string; liveViewUrl?: string; failedStep?: number; currentUrl?: string; stepResults?: Array<{ index: number; action: string; selector?: string; value?: string; status: string; error?: string }>; diagnosis?: string; confidence?: string; suggestedSteps?: Array<{ action: string; selector?: string; value?: string }> | null } }>(`/v1/repositories/${repoId}/cases/${rowId}/run`, {
      clerk_user_id: userId,
      repository_id: repoId,
      application_url: applicationUrl.toString(),
      use_browserbase: useBrowserbase,
      show_browser: showBrowser,
      test_case: { title: testCase.title, description: testCase.description, type: testCase.type, priority: testCase.priority, targetRoute: testCase.targetRoute, targetFiles: testCase.targetFiles, expectedResult: testCase.expectedResult, steps: testCase.steps },
    }, 300_000);
    const result = response.result;
    const failedStep = result.failedStep ? testCase.steps[result.failedStep - 1] : undefined;
    if (
      !result.passed &&
      !result.suggestedSteps?.length &&
      failedStep?.action === "click" &&
      /menu/i.test(failedStep.selector ?? "") &&
      /not visible/i.test(result.details) &&
      !testCase.steps.some((step) => step.action === "setViewport")
    ) {
      const repairedSteps = [...testCase.steps];
      const navigateIndex = repairedSteps.findIndex((step) => step.action === "navigate");
      repairedSteps.splice(navigateIndex < 0 ? 0 : navigateIndex, 0, { action: "setViewport", value: "390x844" });
      result.diagnosis = "The mobile menu toggle is hidden at the current desktop viewport. Set a phone-sized viewport before navigating, then review and save this repair.";
      result.confidence = "high";
      result.suggestedSteps = repairedSteps;
    }
    await db.update(repositoryTestCases).set({ status: result.passed ? "passed" : "failed", lastResult: result, browserbaseScript: renderBrowserScript(testCase.title, testCase.steps), updatedAt: new Date() }).where(scopedCase(userId, repoId, rowId));
    return NextResponse.json({ result });
  } catch (error) { console.error("Browser Execution Agent failed", error); return NextResponse.json({ error: error instanceof Error ? error.message : "Could not run this test case." }, { status: 502 }); }
}
