import json
import os
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import asyncpg
from fastapi import HTTPException


def normalize_database_url(url: str) -> str:
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query.pop("sslmode", None)
    query.pop("channel_binding", None)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


async def init_connection(connection: asyncpg.Connection) -> None:
    await connection.set_type_codec("json", schema="pg_catalog", encoder=json.dumps, decoder=json.loads, format="text")
    await connection.set_type_codec("jsonb", schema="pg_catalog", encoder=json.dumps, decoder=json.loads, format="text")


async def create_pool() -> asyncpg.Pool:
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        raise RuntimeError("DATABASE_URL is required for the Python agent service")
    return await asyncpg.create_pool(normalize_database_url(url), min_size=1, max_size=8, ssl=True, init=init_connection)


def get_service_key(provider: str) -> str:
    env_name = {"groq": "GROQ_API_KEY", "browserbase": "BROWSERBASE_API_KEY"}.get(provider)
    if env_name and os.environ.get(env_name):
        return os.environ[env_name]
    label = "Groq" if provider == "groq" else "Browserbase"
    raise HTTPException(status_code=503, detail=f"{label} is not configured on the agent service.")
