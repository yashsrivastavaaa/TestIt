"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { UserButton, useUser } from "@clerk/nextjs";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BookOpenCheck,
  CheckCircle2,
  Code2,
  GitBranch,
  Github,
  LayoutDashboard,
  LoaderCircle,
  Plus,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useUserContext } from "@/context/user-context";

type WorkspaceRepository = {
  id: string;
  workspaceId?: number;
  name: string;
  fullName: string;
  url: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  added: boolean;
};

type RepositoryPagination = {
  page: number;
  perPage: number;
  totalPages: number | null;
  hasPrevious: boolean;
  hasNext: boolean;
};
type RecentRun = { id: number; title: string; status: string; repositoryName: string; ranAt: string | null; details: string; engine: string };

export default function WorkspacePage() {
  const { user: appUser } = useUserContext();
  const { user: clerkUser } = useUser();
  const greetingName = appUser?.name || clerkUser?.firstName || "there";
  const [timeGreeting, setTimeGreeting] = useState("Hello");
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);
  const [githubAccount, setGithubAccount] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<WorkspaceRepository[]>([]);
  const [addedRepositories, setAddedRepositories] = useState<WorkspaceRepository[]>([]);
  const [repositoryPage, setRepositoryPage] = useState(1);
  const [pagination, setPagination] = useState<RepositoryPagination>({
    page: 1,
    perPage: 10,
    totalPages: 1,
    hasPrevious: false,
    hasNext: false,
  });
  const [repositoriesLoading, setRepositoriesLoading] = useState(true);
  const [githubConnecting, setGithubConnecting] = useState(false);
  const [repositoryActionId, setRepositoryActionId] = useState<string | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null);
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>([]);

  useEffect(() => {
    const updateGreeting = () => {
      const hour = new Date().getHours();
      setTimeGreeting(hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening");
    };
    updateGreeting();
    const intervalId = window.setInterval(updateGreeting, 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  const refreshGithub = useCallback(async () => {
    setRepositoriesLoading(true);
    setGithubError(null);
    try {
      const response = await fetch(`/api/github/repositories?page=${repositoryPage}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load repositories.");
      setGithubConnected(data.connected);
      setGithubAccount(data.account ?? null);
      setRepositories(data.repositories ?? []);
      setAddedRepositories(data.addedRepositories ?? []);
      setPagination(data.pagination ?? { page: 1, perPage: 10, totalPages: 1, hasPrevious: false, hasNext: false });
      if (data.error) setGithubError(data.error);
    } catch (error) {
      setGithubError(error instanceof Error && error.name === "TimeoutError" ? "GitHub is taking too long to respond. Check your connection and try again." : error instanceof Error ? error.message : "Unable to load GitHub repositories.");
      // A failed status check must not leave the connection state unknown forever.
      setGithubConnected((current) => current ?? false);
    } finally {
      setRepositoriesLoading(false);
    }
  }, [repositoryPage]);

  useEffect(() => {
    void refreshGithub();
    const params = new URLSearchParams(window.location.search);
    const callbackError = params.get("error");
    if (callbackError) {
      const messages: Record<string, string> = {
        github_not_configured: "GitHub OAuth is not configured yet. Check the GitHub environment settings.",
        github_denied: "GitHub authorization was cancelled.",
        github_state_mismatch: "GitHub sign-in could not be verified. Please try again.",
        github_token_failed: "GitHub did not return an access token. Please try connecting again.",
        github_profile_failed: "Could not read your GitHub account. Please try connecting again.",
        github_connection_failed: "Could not save your GitHub connection. Please try again.",
        github_oauth_failed: "GitHub connection did not complete. Please try again.",
      };
      setGithubError(messages[callbackError] || "GitHub connection failed. Please try again.");
      window.history.replaceState({}, "", window.location.pathname);
    } else if (params.has("github")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [refreshGithub]);

  useEffect(() => {
    void fetch("/api/workspace/recent-runs", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : { runs: [] })
      .then((data) => setRecentRuns(data.runs ?? []))
      .catch(() => setRecentRuns([]));
  }, []);

  function connectGithub() {
    setGithubConnecting(true);
    window.location.assign("/api/github");
    // Allow another attempt if the OAuth-start navigation is blocked by the browser.
    window.setTimeout(() => setGithubConnecting(false), 12_000);
  }

  async function addRepository(repositoryId: string) {
    setRepositoryActionId(repositoryId);
    setGithubError(null);
    try {
      const response = await fetch("/api/github/repositories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositoryId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not add this repository.");
      setRepositories((current) => current.map((repo) => repo.id === repositoryId ? { ...repo, added: true } : repo));
      if (data.repository) {
        setAddedRepositories((current) => [data.repository, ...current.filter((repo) => repo.id !== repositoryId)]);
        if (data.repository.workspaceId) {
          setWorkspaceNotice(`${data.repository.fullName} was added. Open Tests & Q&A to enter its website URL and analyze it.`);
        }
      }
    } catch (error) {
      setGithubError(error instanceof Error ? error.message : "Could not add this repository.");
    } finally {
      setRepositoryActionId(null);
    }
  }

  async function removeRepository(repositoryId: string) {
    setRepositoryActionId(repositoryId);
    setGithubError(null);
    try {
      const response = await fetch(`/api/github/repositories?repositoryId=${encodeURIComponent(repositoryId)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not remove this repository.");
      setRepositories((current) => current.map((repo) => repo.id === repositoryId ? { ...repo, added: false } : repo));
      setAddedRepositories((current) => current.filter((repo) => repo.id !== repositoryId));
    } catch (error) {
      setGithubError(error instanceof Error ? error.message : "Could not remove this repository.");
    } finally {
      setRepositoryActionId(null);
    }
  }

  async function disconnectGithub() {
    setGithubError(null);
    try {
      const response = await fetch("/api/github", { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not disconnect GitHub.");
      setGithubConnected(false);
      setGithubAccount(null);
      setRepositories([]);
      setAddedRepositories([]);
    } catch (error) {
      setGithubError(error instanceof Error ? error.message : "Could not disconnect GitHub.");
    }
  }

  function browseRepositories() {
    document.getElementById("projects")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <main className="workspace-shell">
      <aside className="workspace-sidebar">
        <Link className="workspace-brand" href="/">
          <span className="workspace-brand-icon"><BookOpenCheck size={19} /></span>
          <span>testit<span>.</span></span>
        </Link>

        <div className="workspace-switcher">
          <span className="switcher-avatar">{(appUser?.name || clerkUser?.firstName || "T").slice(0, 1).toUpperCase()}</span>
          <span className="switcher-copy"><strong>{appUser?.name || "TestIt workspace"}</strong><small>{githubAccount ? `@${githubAccount}` : "Personal workspace"}</small></span>
        </div>

        <div className="workspace-nav-label">WORKSPACE</div>
        <nav className="workspace-nav" aria-label="Workspace navigation">
          <a className="workspace-nav-item selected" href="#overview"><LayoutDashboard size={16} /> Overview</a>
          <a className="workspace-nav-item" href="#projects"><Code2 size={16} /> Projects <span className="nav-count">{addedRepositories.length}</span></a>
          <a className="workspace-nav-item" href="#runs"><Activity size={16} /> Test runs</a>
        </nav>

        <div className="sidebar-upgrade">
          <span><Sparkles size={15} /> TestIt AI</span>
          <p>Let your agent explore your app and write your first test.</p>
          <button disabled={githubConnected === null || githubConnecting} onClick={githubConnected ? browseRepositories : connectGithub}>{githubConnecting ? "Opening GitHub…" : githubConnected === null ? "Checking GitHub…" : githubConnected ? "Add repository" : "Connect GitHub"} <ArrowRight size={13} /></button>
        </div>
        <div className="sidebar-profile">
          <UserButton />
          <span><strong>{clerkUser?.fullName || "Your account"}</strong><small>{clerkUser?.primaryEmailAddress?.emailAddress || "Signed in"}</small></span>
        </div>
      </aside>

      <section className="workspace-content" id="overview">
        <header className="workspace-topbar">
          <div className="breadcrumbs"><span>Workspace</span><span>/</span><strong>Overview</strong></div>
          <div className="topbar-actions"><UserButton /></div>
        </header>

        <div className="workspace-main">
          <div className="workspace-welcome-row">
            <div><div className="workspace-kicker"><span className="live-indicator" /> YOUR TESTING WORKSPACE</div><h1>{timeGreeting}, {greetingName}<span className="wave">✳</span></h1><p>{githubConnected ? `Connected to GitHub as @${githubAccount}. Add repositories to start testing.` : "Connect GitHub to choose repositories and start testing your app with AI."}</p></div>
            <button className="workspace-primary-button" disabled={githubConnected === null || githubConnecting} onClick={githubConnected ? browseRepositories : connectGithub}>{githubConnecting || githubConnected === null ? <LoaderCircle className="repo-spinner" size={16} /> : <Github size={16} />} {githubConnecting ? "Opening GitHub…" : githubConnected === null ? "Checking GitHub…" : githubConnected ? "Add repository" : "Connect GitHub"}</button>
          </div>

          <section className="setup-banner">
            <div className="setup-banner-copy"><div className="setup-icon"><Sparkles size={17} /></div><div><span className="setup-label">{githubConnected === null ? "CHECKING GITHUB CONNECTION" : githubConnected ? `GITHUB CONNECTED · @${githubAccount}` : "YOUR FIRST STEP"}</span><h2>{githubConnected === null ? "Loading your workspace…" : githubConnected ? "Choose a repository to bring into TestIt." : "Bring your code. We’ll handle the testing."}</h2><p>{githubConnected === null ? "Checking your connection and loading repositories." : githubConnected ? "Select repositories from your GitHub account to add them to this workspace." : "Connect GitHub to let TestIt understand your app and build a testing plan."}</p></div></div>
            <div className="setup-decoration">✳</div>
          </section>

          {githubError && <div className="github-error" role="alert"><span>{githubError}</span><button onClick={() => void refreshGithub()}>Try again</button></div>}
          {workspaceNotice && <div className="workspace-notice" role="status">{workspaceNotice}</div>}

          <div className="section-heading-row" id="projects"><div><h2>{githubConnected ? "GitHub repositories" : "Projects"}</h2><p>{githubConnected ? `Repositories available to @${githubAccount}` : "Connect GitHub to add repositories to this workspace"}</p></div>{githubConnected && <button className="filter-button" onClick={() => void refreshGithub()} disabled={repositoriesLoading}>{repositoriesLoading ? <><LoaderCircle className="repo-spinner" size={14} /> Refreshing…</> : "Refresh list"}</button>}</div>

          {repositoriesLoading ? (
            <section className="github-repo-list" aria-label="Loading GitHub repositories" aria-busy="true">
              {Array.from({ length: 5 }, (_, index) => <div className="github-repo-skeleton" key={index}><span className="skeleton-repo-icon" /><div className="skeleton-repo-copy"><i /><i /><i /></div><span className="skeleton-repo-button" /></div>)}
            </section>
          ) : !githubConnected ? (
            <section className="empty-projects">
              <div className="empty-illustration"><div className="empty-orbit orbit-one" /><div className="empty-orbit orbit-two" /><div className="empty-code-icon"><Github size={29} /></div><span className="orbit-spark spark-one">✦</span><span className="orbit-spark spark-two">✳</span></div>
              <h3>Connect GitHub to get started</h3>
              <p>Choose repositories from your account and let your AI agent map important user journeys.</p>
              <button className="workspace-primary-button" disabled={githubConnecting} onClick={connectGithub}>{githubConnecting ? <LoaderCircle className="repo-spinner" size={16} /> : <Github size={16} />} {githubConnecting ? "Opening GitHub…" : "Connect GitHub"}</button>
              <div className="empty-footnote"><ShieldCheck size={13} /> Your access token is encrypted and never sent to the browser.</div>
            </section>
          ) : (
            <>
              {addedRepositories.length > 0 && <section className="added-repositories"><div className="repo-list-heading"><div><h3>Added to this workspace</h3><p>Your connected repositories, ready for analysis</p></div><span className="added-count">{addedRepositories.length} {addedRepositories.length === 1 ? "repository" : "repositories"}</span></div><div className="added-repo-list">{addedRepositories.map((repo) => <article className="added-repo-card" key={repo.id}><span className="added-repo-icon"><Github size={21} /></span><div className="added-repo-details"><div className="added-repo-title"><h4>{repo.fullName}</h4><span className="repo-connected-status"><i /> Connected</span></div><p>{repo.description || "No repository description provided."}</p><div className="added-repo-meta"><span>{repo.isPrivate ? "Private repository" : "Public repository"}</span><i /><span><GitBranch size={13} /> {repo.defaultBranch}</span></div></div><div className="added-repo-actions">{repo.workspaceId && <Link className="added-repo-primary" href={`/workspace/repositories/${repo.workspaceId}`}>Tests &amp; Q&amp;A <ArrowRight size={15} /></Link>}<a className="added-repo-external" aria-label={`Open ${repo.fullName} on GitHub`} href={repo.url} target="_blank" rel="noreferrer"><ArrowUpRight size={16} /></a></div></article>)}</div></section>}
              <section className="github-repo-list">
                {repositories.length === 0 ? <div className="github-repo-loading">No repositories were found for this GitHub account.</div> : repositories.map((repo) => <article className="github-repo-row" key={repo.id}><div className="repo-row-icon"><Github size={18} /></div><div className="repo-row-copy"><a href={repo.url} target="_blank" rel="noreferrer">{repo.fullName}<ArrowUpRight size={12} /></a><p>{repo.description || "No description provided."}</p><div className="repo-row-meta"><span>{repo.isPrivate ? "Private" : "Public"}</span><i /> <span><GitBranch size={12} /> {repo.defaultBranch}</span></div></div><button className={repo.added ? "repo-added-button" : "repo-add-button"} disabled={repositoryActionId === repo.id} onClick={() => void (repo.added ? removeRepository(repo.id) : addRepository(repo.id))}>{repositoryActionId === repo.id ? <><LoaderCircle className="repo-spinner" size={13} /> Adding…</> : repo.added ? "Added · Remove" : <><Plus size={14} /> Add repo</>}</button></article>)}
              </section>
              {(pagination.hasPrevious || pagination.hasNext || (pagination.totalPages ?? 1) > 1) && <nav className="repo-pagination" aria-label="Repository pages"><span>Page {pagination.page}{pagination.totalPages ? ` of ${pagination.totalPages}` : ""}</span><div><button disabled={!pagination.hasPrevious || repositoriesLoading} onClick={() => setRepositoryPage((current) => Math.max(1, current - 1))}>Previous</button><button disabled={!pagination.hasNext || repositoriesLoading} onClick={() => setRepositoryPage((current) => current + 1)}>Next</button></div></nav>}
              <div className="github-account-actions"><span>Connected as <strong>@{githubAccount}</strong></span><button onClick={() => void disconnectGithub()}>Disconnect GitHub</button></div>
            </>
          )}
          <div className="workspace-lower-grid" id="runs">
            <section className="lower-card recent-runs-card" aria-label="Recent test runs">
              <div className="lower-card-heading">
                <div><h3>Recent test runs</h3><p>Latest completed browser checks</p></div>
                {recentRuns.length > 0 && <span className="recent-run-count">{recentRuns.length} {recentRuns.length === 1 ? "run" : "runs"}</span>}
              </div>
              {recentRuns.length ? (
                <div className="recent-run-list">
                  {recentRuns.map((run) => {
                    const workspaceId = addedRepositories.find((repo) => repo.fullName === run.repositoryName)?.workspaceId;
                    const passed = run.status === "passed";
                    return (
                      <Link className="recent-run-item" href={workspaceId ? `/workspace/repositories/${workspaceId}` : "#runs"} key={run.id}>
                        <span className={`recent-run-icon ${passed ? "passed" : "failed"}`} aria-label={passed ? "Passed" : "Failed"}>
                          {passed ? <CheckCircle2 size={19} /> : <XCircle size={19} />}
                        </span>
                        <span className="recent-run-copy">
                          <strong>{run.title}</strong>
                          <span className="recent-run-meta"><small>{run.repositoryName}</small><i /> <small>{run.engine || "Browser test"}</small></span>
                        </span>
                        <span className="recent-run-trailing">
                          <span className={`recent-run-result ${passed ? "passed" : "failed"}`}>{passed ? "Passed" : "Failed"}</span>
                          <time dateTime={run.ranAt ?? undefined}>{run.ranAt ? new Date(run.ranAt).toLocaleString() : "Recently"}</time>
                          <ArrowUpRight size={15} aria-hidden="true" />
                        </span>
                      </Link>
                    );
                  })}
                </div>
              ) : <div className="lower-empty"><p>Completed runs will appear here after you run a test case.</p></div>}
            </section>
            <section className="lower-card agent-card"><div className="lower-card-heading"><div><h3>Meet your AI agent</h3><p>A QA teammate that never clocks out</p></div><Sparkles size={17} /></div><div className="agent-card-body"><div className="agent-avatars"><span>✦</span><i /></div><strong>Ready when you are</strong><p>Connect a repo and your agent will start learning how your app works.</p></div></section>
          </div>

          <footer className="workspace-footer"><span>TestIt workspace</span><span>Built for better software <span className="footer-heart">♥</span></span><nav aria-label="Creator links"><a href="https://github.com/yashsrivastavaaa/" target="_blank" rel="noreferrer">GitHub profile</a><a href="https://portfolio-five-ashen-57.vercel.app/" target="_blank" rel="noreferrer">Portfolio</a></nav></footer>
        </div>
      </section>

    </main>
  );
}
