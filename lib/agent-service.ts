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
  const responseBody = await response.text();
  let data: { detail?: unknown; error?: unknown } = {};
  try {
    data = JSON.parse(responseBody) as { detail?: unknown; error?: unknown };
  } catch {
    // Render/proxy failures can return an HTML or plain-text body instead of
    // FastAPI's JSON error shape. Preserve a short, readable hint for the UI.
  }
  if (!response.ok) {
    const plainText = responseBody.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const reason = typeof data.detail === "string"
      ? data.detail
      : typeof data.error === "string"
        ? data.error
        : plainText
          ? `Python agent service returned ${response.status}: ${plainText.slice(0, 300)}`
          : `Python agent service returned ${response.status} with an empty response. Check the Render service logs at the same timestamp; the service may have restarted or failed before returning an API error.`;
    throw new Error(reason);
  }
  return data as T;
}
