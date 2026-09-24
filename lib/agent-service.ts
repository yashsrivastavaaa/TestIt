import "server-only";

export async function callAgentService<T>(path: string, payload: unknown, timeoutMs = 120_000): Promise<T> {
  const baseUrl = process.env.AGENT_SERVICE_URL?.replace(/\/$/, "");
  const token = process.env.AGENT_SERVICE_TOKEN;
  if (!baseUrl || !token) throw new Error("Python agent service is not configured. Set AGENT_SERVICE_URL and AGENT_SERVICE_TOKEN in the server environment.");
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-token": token },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new Error("The Python agent service timed out. Try again or check its logs.");
    throw new Error("Could not reach the Python agent service. Confirm it is running and AGENT_SERVICE_URL is correct.");
  }
  const data = await response.json().catch(() => ({})) as { detail?: unknown; error?: unknown };
  if (!response.ok) {
    const reason = typeof data.detail === "string" ? data.detail : typeof data.error === "string" ? data.error : `Python agent service returned ${response.status}.`;
    throw new Error(reason);
  }
  return data as T;
}
