import { timingSafeEqual } from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db, githubConnections, githubRepositories } from "@/db";
import { encryptGithubToken } from "@/lib/github-token";

type GithubTokenResponse = { access_token?: string; error?: string; error_description?: string };
type GithubProfile = { id: number; login: string };

function workspaceError(request: NextRequest, code: string) {
  const response = NextResponse.redirect(new URL(`/workspace?error=${code}`, request.url));
  clearOAuthCookies(response);
  return response;
}

function clearOAuthCookies(response: NextResponse) {
  response.cookies.set("github_oauth_state", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/api/github/callback",
  });
  response.cookies.set("gh_token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
}

export async function GET(request: NextRequest) {
  const { userId } = await auth();
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const returnedState = searchParams.get("state");
  const expectedState = request.cookies.get("github_oauth_state")?.value;

  if (searchParams.get("error")) return workspaceError(request, "github_denied");
  if (!userId || !code || !returnedState || !expectedState) {
    return workspaceError(request, "github_oauth_failed");
  }

  const returned = Buffer.from(returnedState);
  const expected = Buffer.from(expectedState);
  if (returned.length !== expected.length || !timingSafeEqual(returned, expected)) {
    return workspaceError(request, "github_state_mismatch");
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const redirectUri = process.env.GITHUB_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return workspaceError(request, "github_not_configured");
  }

  try {
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!tokenResponse.ok) return workspaceError(request, "github_token_failed");
    const tokenData = await tokenResponse.json() as GithubTokenResponse;
    if (!tokenData.access_token) return workspaceError(request, "github_token_failed");

    const profileResponse = await fetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${tokenData.access_token}`,
        "x-github-api-version": "2022-11-28",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!profileResponse.ok) return workspaceError(request, "github_profile_failed");
    const profile = await profileResponse.json() as GithubProfile;

    const [existingConnection] = await db.select({ githubUserId: githubConnections.githubUserId })
      .from(githubConnections)
      .where(eq(githubConnections.clerkUserId, userId))
      .limit(1);
    if (existingConnection && existingConnection.githubUserId !== String(profile.id)) {
      await db.delete(githubRepositories).where(eq(githubRepositories.clerkUserId, userId));
    }

    const encryptedAccessToken = encryptGithubToken(tokenData.access_token);
    await db.insert(githubConnections).values({
      clerkUserId: userId,
      githubUserId: String(profile.id),
      githubLogin: profile.login,
      encryptedAccessToken,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: githubConnections.clerkUserId,
      set: {
        githubUserId: String(profile.id),
        githubLogin: profile.login,
        encryptedAccessToken,
        updatedAt: new Date(),
      },
    });

    const response = NextResponse.redirect(new URL("/workspace?github=connected", request.url));
    clearOAuthCookies(response);
    return response;
  } catch (error) {
    console.error("GitHub OAuth callback failed:", error);
    return workspaceError(request, "github_connection_failed");
  }
}
