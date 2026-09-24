import asyncio
import re
import threading
from collections import defaultdict

import asyncpg
from fastembed import TextEmbedding

EMBEDDING_DIMS = 768
EMBEDDING_MODEL_NAME = "BAAI/bge-base-en-v1.5"
CHUNK_CHARS = 4200
CHUNK_OVERLAP = 500
_embedding_model: TextEmbedding | None = None
_embedding_lock = threading.Lock()


def _model() -> TextEmbedding:
    global _embedding_model
    if _embedding_model is None:
        with _embedding_lock:
            if _embedding_model is None:
                _embedding_model = TextEmbedding(model_name=EMBEDDING_MODEL_NAME)
    return _embedding_model


def _embed_sync(texts: list[str], is_query: bool = False) -> list[list[float]]:
    if is_query:
        texts = [f"Represent this sentence for searching relevant passages: {text}" for text in texts]
    windows: list[str] = []
    owners: list[int] = []
    for owner, text in enumerate(texts):
        # The encoder accepts at most 512 tokens. Embed long source chunks as
        # smaller windows so details near the end are represented as well.
        for offset in range(0, max(1, len(text)), 1400):
            windows.append(text[offset : offset + 1400])
            owners.append(owner)
    vectors = [vector.tolist() for vector in _model().embed(windows)]
    grouped: list[list[list[float]]] = [[] for _ in texts]
    for owner, vector in zip(owners, vectors, strict=True):
        grouped[owner].append(vector)
    return [
        [sum(vector[dimension] for vector in parts) / len(parts) for dimension in range(EMBEDDING_DIMS)]
        for parts in grouped
    ]


async def embed_texts(texts: list[str], is_query: bool = False) -> list[list[float]]:
    if not texts:
        return []
    return await asyncio.to_thread(_embed_sync, texts, is_query)


def _vector_literal(vector: list[float]) -> str:
    if len(vector) != EMBEDDING_DIMS:
        raise ValueError(f"Embedding model returned {len(vector)} dimensions; expected {EMBEDDING_DIMS}.")
    return "[" + ",".join(f"{value:.8f}" for value in vector) + "]"


def chunk_source(path: str, content: str) -> list[dict]:
    """Create overlapping line-aligned chunks and retain source line ranges."""
    content = content.replace("\r\n", "\n")
    lines = content.splitlines()
    if not lines:
        return []
    chunks: list[dict] = []
    start = 0
    while start < len(lines):
        end = start
        size = 0
        while end < len(lines) and size + len(lines[end]) + 1 <= CHUNK_CHARS:
            size += len(lines[end]) + 1
            end += 1
        if end == start:
            line = lines[start]
            for offset in range(0, len(line), CHUNK_CHARS - CHUNK_OVERLAP):
                chunk_text = line[offset : offset + CHUNK_CHARS]
                if chunk_text.strip():
                    chunks.append({"path": path, "content": chunk_text, "start_line": start + 1, "end_line": start + 1})
            start += 1
            continue
        excerpt = "\n".join(lines[start:end]).strip()
        if excerpt:
            chunks.append({"path": path, "content": excerpt, "start_line": start + 1, "end_line": end})
        if end >= len(lines):
            break
        overlap_size = 0
        next_start = end
        while next_start > start and overlap_size < CHUNK_OVERLAP:
            next_start -= 1
            overlap_size += len(lines[next_start]) + 1
        start = max(start + 1, next_start)
    return chunks


async def index_repository(pool: asyncpg.Pool, user_id: str, repository_id: int, repository_name: str, commit_sha: str, files: list[dict], test_cases: list[dict]) -> int:
    chunks: list[dict] = []
    for file in files:
        chunks.extend(chunk_source(file["path"], file["content"]))
    for index, case in enumerate(test_cases):
        path = f"tests/case-{index + 1}-{re.sub(r'[^a-z0-9]+', '-', case['title'].lower()).strip('-')[:70]}"
        case_content = f"Title: {case['title']}\nType: {case['type']}\nPriority: {case.get('priority', 'medium')}\nRoute: {case.get('targetRoute', '/')}\nSource files: {', '.join(case.get('targetFiles', []))}\nExpected result: {case.get('expectedResult', '')}\nDescription: {case['description']}\nSteps: {case['steps']}"
        chunks.extend(chunk_source(path, case_content))
    if not chunks:
        raise ValueError("No repository source chunks were created for indexing")

    counts: dict[str, int] = defaultdict(int)
    rows = []
    texts = []
    for chunk in chunks:
        ordinal = counts[chunk["path"]]
        counts[chunk["path"]] += 1
        storage_path = f"{chunk['path']}#chunk:{ordinal:04d}"
        text = f"File: {chunk['path']} (lines {chunk['start_line']}-{chunk['end_line']})\n{chunk['content']}"
        rows.append((storage_path, text))
        texts.append(text)

    vectors = await embed_texts(texts)
    async with pool.acquire() as connection:
        async with connection.transaction():
            await connection.execute("DELETE FROM repository_knowledge WHERE clerk_user_id=$1 AND repository_id=$2", user_id, repository_id)
            await connection.executemany(
                "INSERT INTO repository_knowledge (clerk_user_id, repository_id, path, commit_sha, content, embedding, updated_at) VALUES ($1,$2,$3,$4,$5,$6::vector,now())",
                [(user_id, repository_id, path, commit_sha, content, _vector_literal(vector)) for (path, content), vector in zip(rows, vectors, strict=True)],
            )
    return len(rows)


async def _backfill_zero_embeddings(pool: asyncpg.Pool, user_id: str, repository_ids: list[int]) -> None:
    """Upgrade legacy placeholder vectors the first time each corpus is searched."""
    async with pool.acquire() as connection:
        stale = await connection.fetch(
            "SELECT id, content FROM repository_knowledge WHERE clerk_user_id=$1 AND repository_id = ANY($2::int[]) AND vector_norm(embedding)=0",
            user_id, repository_ids,
        )
    if not stale:
        return
    vectors = await embed_texts([row["content"] for row in stale])
    async with pool.acquire() as connection:
        async with connection.transaction():
            await connection.executemany(
                "UPDATE repository_knowledge SET embedding=$2::vector, updated_at=now() WHERE id=$1 AND clerk_user_id=$3",
                [(row["id"], _vector_literal(vector), user_id) for row, vector in zip(stale, vectors, strict=True)],
            )


def _hybrid_retrieve(semantic_rows: list[dict], lexical_rows: list[dict], limit: int = 8) -> list[dict]:
    """Fuse semantic and lexical rankings with reciprocal rank fusion."""
    fused: dict[int, dict] = {}
    for rows in (semantic_rows, lexical_rows):
        for rank, row in enumerate(rows, 1):
            item = dict(row)
            key = int(item["id"])
            if key not in fused:
                fused[key] = item
                fused[key]["_rrf"] = 0.0
            fused[key]["_rrf"] += 1.0 / (60 + rank)
    ordered = sorted(fused.values(), key=lambda row: row["_rrf"], reverse=True)
    result: list[dict] = []
    per_path: defaultdict[str, int] = defaultdict(int)
    for row in ordered:
        source_path = re.sub(r"#chunk:\d+$", "", row["path"])
        repository_name = row.get("repository_name", "")
        dedupe_key = f"{repository_name}:{source_path}"
        if per_path[dedupe_key] >= 2:
            continue
        per_path[dedupe_key] += 1
        passage = {"path": source_path, "content": row["content"]}
        if "repository_name" in row:
            passage["repository_name"] = repository_name
            passage["repository_id"] = row["repository_id"]
        result.append(passage)
        if len(result) >= limit:
            break
    return result


async def retrieve_repository(pool: asyncpg.Pool, user_id: str, repository_id: int, question: str) -> list[dict]:
    await _backfill_zero_embeddings(pool, user_id, [repository_id])
    query_vector = _vector_literal((await embed_texts([question], is_query=True))[0])
    async with pool.acquire() as connection:
        async with connection.transaction():
            await connection.execute("SET LOCAL hnsw.ef_search = 100")
            semantic_rows = await connection.fetch(
                "SELECT id,path,content FROM repository_knowledge WHERE clerk_user_id=$1 AND repository_id=$2 AND vector_norm(embedding)>0 ORDER BY embedding <=> $3::vector LIMIT 40",
                user_id, repository_id, query_vector,
            )
            lexical_rows = await connection.fetch(
                "WITH query AS (SELECT plainto_tsquery('simple', $3) AS q) SELECT d.id,d.path,d.content FROM repository_knowledge d,query WHERE d.clerk_user_id=$1 AND d.repository_id=$2 AND to_tsvector('simple',d.path || ' ' || d.content) @@ query.q ORDER BY ts_rank_cd(to_tsvector('simple',d.path || ' ' || d.content),query.q) DESC LIMIT 40",
                user_id, repository_id, question,
            )
    return _hybrid_retrieve([dict(row) for row in semantic_rows], [dict(row) for row in lexical_rows])


async def retrieve_workspace_knowledge(pool: asyncpg.Pool, user_id: str, question: str) -> list[dict]:
    async with pool.acquire() as connection:
        repository_ids = [row["id"] for row in await connection.fetch(
            "SELECT DISTINCT d.repository_id AS id FROM repository_knowledge d JOIN github_repositories r ON r.id=d.repository_id AND r.clerk_user_id=d.clerk_user_id WHERE d.clerk_user_id=$1",
            user_id,
        )]
    if not repository_ids:
        return []
    await _backfill_zero_embeddings(pool, user_id, repository_ids)
    query_vector = _vector_literal((await embed_texts([question], is_query=True))[0])
    async with pool.acquire() as connection:
        async with connection.transaction():
            await connection.execute("SET LOCAL hnsw.ef_search = 100")
            semantic_rows = await connection.fetch(
                """SELECT d.id,d.repository_id,r.full_name AS repository_name,d.path,d.content
                FROM repository_knowledge d JOIN github_repositories r ON r.id=d.repository_id AND r.clerk_user_id=d.clerk_user_id
                WHERE d.clerk_user_id=$1 AND d.repository_id=ANY($2::int[]) AND vector_norm(d.embedding)>0
                ORDER BY d.embedding <=> $3::vector LIMIT 60""",
                user_id, repository_ids, query_vector,
            )
            lexical_rows = await connection.fetch(
                """WITH query AS (SELECT plainto_tsquery('simple',$2) AS q)
                SELECT d.id,d.repository_id,r.full_name AS repository_name,d.path,d.content
                FROM repository_knowledge d JOIN github_repositories r ON r.id=d.repository_id AND r.clerk_user_id=d.clerk_user_id,query
                WHERE d.clerk_user_id=$1
                  AND to_tsvector('simple',d.path || ' ' || d.content || ' ' || r.full_name) @@ query.q
                ORDER BY ts_rank_cd(to_tsvector('simple',d.path || ' ' || d.content || ' ' || r.full_name),query.q) DESC LIMIT 60""",
                user_id, question,
            )
    passages = _hybrid_retrieve([dict(row) for row in semantic_rows], [dict(row) for row in lexical_rows], limit=12)
    if passages:
        return passages

    # If the query has no matching terms (or old vector rows were empty), still
    # give workspace chat real source context from each previously indexed repo.
    async with pool.acquire() as connection:
        fallback_rows = await connection.fetch(
            """WITH ranked AS (
                SELECT d.id,d.repository_id,r.full_name AS repository_name,d.path,d.content,
                       row_number() OVER (PARTITION BY d.repository_id ORDER BY d.updated_at DESC,d.id) AS repo_rank
                FROM repository_knowledge d
                JOIN github_repositories r ON r.id=d.repository_id AND r.clerk_user_id=d.clerk_user_id
                WHERE d.clerk_user_id=$1 AND d.repository_id=ANY($2::int[])
            )
            SELECT id,repository_id,repository_name,path,content FROM ranked
            WHERE repo_rank<=2 ORDER BY repository_name,repo_rank LIMIT 12""",
            user_id, repository_ids,
        )
    return _hybrid_retrieve([], [dict(row) for row in fallback_rows], limit=12)
