# TestIt Python Agent Service

FastAPI service for TestIt's AI agents and retrieval-augmented repository chat. The Next.js app authenticates users and calls this private service with the shared `AGENT_SERVICE_TOKEN`.

For the full product overview and local setup, see the [project README](../README.md). Its [agent architecture](../README.md#agent-architecture) section documents planning, browser execution, debugging, service endpoints, and data ownership. The [RAG architecture](../README.md#rag-architecture) section documents chunking, embeddings, hybrid retrieval, rank fusion, and chat context.

## Run locally (PowerShell)

From the project root, apply the agent database migration once:

```powershell
npm run db:migrate:agents
```

Then start the Python service in its own terminal:

```powershell
cd agent_service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
if (!(Test-Path .env)) { Copy-Item .env.example .env }
.\.venv\Scripts\python.exe -m playwright install chromium
uvicorn app.main:app --env-file .env --host 127.0.0.1 --port 8001 --reload
```

Set these values in `agent_service/.env`:

- `DATABASE_URL`: PostgreSQL connection string used by the web app.
- `AGENT_SERVICE_TOKEN`: same long random secret as the root `.env`.
- `GROQ_API_KEY`: Groq API key.
- `GROQ_MODEL`: optional model override; defaults to `openai/gpt-oss-120b`.
- `GROQ_MAX_TOKENS`: optional model output limit.
- `PLANNER_SOURCE_CHAR_LIMIT`: optional planner source budget, capped at 12,000 characters.

Set `AGENT_SERVICE_URL=http://127.0.0.1:8001` in the root `.env`. The service health endpoint is `http://127.0.0.1:8001/health`.

The workspace runs approved browser steps in local Chromium by default. To see the browser, run Uvicorn in an interactive desktop session. Install Chromium using the service virtual environment command above.

## Agents

- **Planner:** Groq reviews changed source and drafts up to the requested 1-10 editable, repository-grounded test cases. It may return fewer when the source does not support more.
- **Browser execution:** Playwright runs the approved step list in local Chromium, visibly by default.
- **Debug and self-healing:** Groq explains failures from captured evidence and suggests repairs for a person to review.
- **Repository chat:** Retrieves matching source and saved tests, includes recent conversation turns, and uses Groq to answer with file citations. Workspace chat can search across analyzed repositories.

## RAG retrieval

1. Split source files and saved tests into overlapping chunks.
2. Embed chunks locally with FastEmbed's `BAAI/bge-base-en-v1.5` model (768 dimensions).
3. Store vectors in PostgreSQL with pgvector and index content for full-text search.
4. Retrieve vector-similar and full-text matches, fuse rankings with reciprocal rank fusion, and pass relevant evidence and recent chat turns to Groq.

FastEmbed downloads its embedding model the first time it is used and caches it for subsequent requests. Legacy zero vectors are regenerated when their repository is searched.

## AI safety guardrails

- System instructions are separate from untrusted repository files, diffs, user prompts, saved tests, and chat history.
- Common API tokens, passwords, bearer tokens, and private-key blocks are redacted before model calls and RAG indexing.
- Planner output is validated against supplied routes, paths, selectors, and visible text. Unsupported plans are rejected rather than run.
- Browser navigation stays on the website under test, destructive or financial interactions are blocked, and execution uses a fixed Playwright action allowlist.
- Debug suggestions must match captured page controls and are shown for review; the agent does not execute generated JavaScript.

## Database migration

Run `npm run db:migrate:agents` from the project root. The idempotent migration enables pgvector, creates the agent tables and search indexes, and adds test-case metadata columns. It assumes the original GitHub application tables already exist.
