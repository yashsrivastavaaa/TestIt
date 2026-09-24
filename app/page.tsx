"use client";

import Link from "next/link";
import { useUser } from "@clerk/nextjs";

function Mark({ className = "" }: { className?: string }) {
  return (
    <span className={`brand-mark ${className}`} aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path d="M7 7h18v18H7z" stroke="currentColor" strokeWidth="2" />
        <path d="m11 16 3.2 3.2L21.5 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M16 2v5M30 16h-5M16 30v-5M2 16h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

const features = [
  { number: "01", title: "Tests grounded in your code", body: "Analyze repository changes, focus cases on a feature, and review the source files and steps behind each test." },
  { number: "02", title: "Watch browser runs", body: "Run approved cases in visible Chromium and inspect the failing step, selector, URL, and captured page controls." },
  { number: "03", title: "Repository answers with citations", body: "Ask about analyzed code and saved cases. Answers draw on semantically retrieved files and cite their sources." },
];

export default function Home() {
  const { isLoaded, isSignedIn } = useUser();
  const primaryHref = isLoaded && !isSignedIn ? "/sign-up" : "/workspace";
  const primaryLabel = isLoaded && !isSignedIn ? "Get started" : "Open workspace";
  return (
    <main className="landing-shell">
      <header className="site-header">
        <Link href="/" className="wordmark" aria-label="TestIt home">
          <Mark /> <span>testit<span className="wordmark-dot">.</span></span>
        </Link>
        <nav className="main-nav" aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#features">Features</a>
          <a href="#runs">Platform</a>
        </nav>
        <div className="header-actions">
          {isLoaded && !isSignedIn && <Link className="header-login" href="/sign-in">Log in</Link>}
          <Link className="button button-dark button-small" href={primaryHref}>{primaryLabel} <span aria-hidden="true">↗</span></Link>
        </div>
      </header>

      <section className="hero-section">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-pulse" /> AI-POWERED TEST AUTOMATION</div>
          <h1>Ship with confidence.<br /><span>Let AI do the testing.</span></h1>
          <p className="hero-description">Your AI testing agent analyzes repository changes, drafts code-grounded browser tests, and shows where a run fails. Review each case before it runs.</p>
          <div className="hero-actions">
            <Link className="button button-dark" href={primaryHref}>{isLoaded && !isSignedIn ? "Start testing free" : "Open workspace"} <span aria-hidden="true">↗</span></Link>
            <a className="text-link" href="#how-it-works"><span className="play-icon">▶</span> See how it works</a>
          </div>
        </div>

        <div className="product-preview" id="runs" aria-label="TestIt dashboard preview">
          <div className="preview-glow" />
          <div className="dashboard-window">
            <aside className="dashboard-sidebar">
              <div className="mini-brand"><Mark /><span>testit</span></div>
              <div className="workspace-label">WORKSPACE</div>
              <div className="workspace-select"><span className="workspace-avatar">A</span> Acme Studio <span className="chevron">⌄</span></div>
              <Link className="sidebar-link active" href="/workspace"><span>◫</span> Overview</Link>
              <Link className="sidebar-link" href="/workspace#projects"><span>◇</span> Repositories</Link>
              <Link className="sidebar-link" href="/workspace#runs"><span>◷</span> Run history</Link>
              <div className="sidebar-bottom"><span className="online-dot" /> All systems operational</div>
            </aside>
            <div className="dashboard-main">
              <div className="dashboard-top"><span>Workspace / <strong>Overview</strong></span><span className="preview-demo-label">Illustrative preview</span><div className="user-chip">JD</div></div>
              <div className="dashboard-heading"><div><div className="date-label">MONDAY, OCTOBER 21</div><h2>Good morning, Jordan <span>✦</span></h2><p>Here’s what’s happening with your tests.</p></div><Link className="run-button" href="/workspace"><span>↗</span> Open workspace</Link></div>
              <div className="metric-row">
                <div className="metric-card"><span>TESTS PASSED</span><strong>98.4%</strong><small className="metric-up">↗ 2.1% <i>vs last week</i></small><div className="sparkline"><span /><span /><span /><span /><span /><span /><span /><span /><span /></div></div>
                <div className="metric-card"><span>TESTS RUN</span><strong>1,284</strong><small className="metric-up">↗ 18.6% <i>vs last week</i></small><div className="sparkline sparkline-purple"><span /><span /><span /><span /><span /><span /><span /><span /><span /></div></div>
                <div className="metric-card"><span>ISSUES FOUND</span><strong>12</strong><small className="metric-down">↓ 4 this week <i>great progress</i></small><div className="sparkline sparkline-orange"><span /><span /><span /><span /><span /><span /><span /><span /><span /></div></div>
              </div>
              <div className="runs-panel">
                <div className="runs-title"><div><h3>Recent test runs</h3><p>Your latest automated checks</p></div><a href="#features">View all →</a></div>
                <div className="run-row"><span className="run-status success">✓</span><div className="run-info"><strong>Checkout flow</strong><small>Production · Chrome</small></div><span className="run-result passed">Passed</span><span className="run-time">2 min ago</span><span className="run-duration">1m 24s</span></div>
                <div className="run-row"><span className="run-status success">✓</span><div className="run-info"><strong>User sign up</strong><small>Staging · Chrome</small></div><span className="run-result passed">Passed</span><span className="run-time">18 min ago</span><span className="run-duration">0m 48s</span></div>
                <div className="run-row"><span className="run-status warning">!</span><div className="run-info"><strong>Search products</strong><small>Staging · Firefox</small></div><span className="run-result needs-review">Review</span><span className="run-time">1 hour ago</span><span className="run-duration">2m 06s</span></div>
              </div>
              <div className="agent-toast"><span className="agent-spark">✦</span><div><strong>Test agent found something</strong><small>Checkout button is unresponsive on mobile</small></div><span className="toast-arrow">↗</span></div>
            </div>
          </div>
          <div className="floating-note note-top"><span className="note-icon">✦</span><div><strong>AI agent is exploring</strong><small>Found 3 user flows</small></div><span className="note-live" /></div>
          <div className="floating-note note-bottom"><span className="pass-ring">✓</span><div><strong>All checks passed</strong><small>just now · 12 test cases</small></div></div>
        </div>
      </section>

      <section className="trust-strip"><span>YOUR QA TEAM, ON AUTOPILOT</span><div><i>◈</i> Built for modern web apps <b /> <i>⌘</i> Works with your stack <b /> <i>↗</i> Ready for every release</div></section>

      <section className="features-section" id="features">
        <div className="section-intro"><div className="eyebrow">A BETTER WAY TO TEST</div><h2>Less time debugging.<br /><span>More time building.</span></h2><p>TestIt handles the repetitive work of quality assurance, so your team can focus on what makes your product great.</p></div>
        <div className="feature-grid">{features.map((feature) => <article className="feature-card" key={feature.number}><span className="feature-number">{feature.number}</span><div className="feature-icon">{feature.number === "01" ? "✳" : feature.number === "02" ? "◎" : "↗"}</div><h3>{feature.title}</h3><p>{feature.body}</p><a href="#how-it-works">Explore feature <span>→</span></a></article>)}</div>
      </section>

      <section className="workflow-section" id="how-it-works"><div className="workflow-copy"><div className="eyebrow">FROM PROMPT TO PEACE OF MIND</div><h2>Testing that moves<br />at the speed of <span>you.</span></h2><p>Connect a GitHub repository, choose what to test, and review code-grounded cases before running them in a visible browser.</p><Link className="button button-light" href="/workspace">Open your workspace <span>↗</span></Link></div><div className="workflow-steps"><div><span>01</span><section><strong>Connect GitHub</strong><p>Choose a repository from your connected GitHub account.</p></section><i>✓</i></div><div><span>02</span><section><strong>Describe what to test</strong><p>Describe a feature and get test cases grounded in repository code.</p></section><i>✦</i></div><div><span>03</span><section><strong>Ship without the guesswork</strong><p>Get clear results and actionable bug reports with every run.</p></section><i>↗</i></div></div></section>

      <footer className="site-footer"><Link href="/" className="wordmark"><Mark /><span>testit<span className="wordmark-dot">.</span></span></Link><span>Quality checks that keep up with you.</span><div>{isLoaded && (isSignedIn ? <Link href="/workspace">Open workspace</Link> : <><Link href="/sign-in">Log in</Link><Link href="/sign-up">Get started</Link></>)}</div><small>© {new Date().getFullYear()} TestIt. Built for better software.</small></footer>
    </main>
  );
}
