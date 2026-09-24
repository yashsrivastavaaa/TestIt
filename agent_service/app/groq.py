import os
import logging
import re
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
from dotenv import dotenv_values, load_dotenv

# Load local configuration regardless of the shell's current directory.
SERVICE_ENV = Path(__file__).resolve().parents[1] / ".env"
load_dotenv(SERVICE_ENV, override=False)

MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
BASE_URL = os.environ.get("GROQ_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")
MAX_TOKENS = int(os.environ.get("GROQ_MAX_TOKENS", "2048"))
logger = logging.getLogger(__name__)
_key_index = 0
_key_lock = threading.Lock()


def _configured_keys() -> list[str]:
    """Read the key pool, falling back to the legacy single-key setting."""
    file_values = dotenv_values(SERVICE_ENV)
    pool_value = os.environ.get("GROQ_API_KEYS") or file_values.get("GROQ_API_KEYS") or ""
    keys = [value.strip() for value in re.split(r"[,;\s]+", str(pool_value)) if value.strip()]
    if keys:
        return keys
    single_key = os.environ.get("GROQ_API_KEY") or file_values.get("GROQ_API_KEY") or ""
    return [str(single_key).strip()] if str(single_key).strip() else []


def _next_key(fallback: str | None = None) -> str:
    global _key_index
    keys = _configured_keys()
    if not keys and fallback and fallback.strip():
        keys = [fallback.strip()]
    if not keys:
        raise RuntimeError("Groq is not configured. Set GROQ_API_KEYS or GROQ_API_KEY in agent_service/.env and restart the agent service.")
    with _key_lock:
        key = keys[_key_index % len(keys)]
        _key_index += 1
    return key


def generate_text(
    *,
    contents: str,
    system: str | None = None,
    api_key: str | None = None,
    json_mode: bool = False,
    temperature: float = 0.1,
    max_tokens: int | None = None,
):
    # Rotate once per model call. Rate-limit retries within this call stay on
    # the selected key; the next agent call advances through the pool.
    key = _next_key(api_key)

    messages = []
    if system and system.strip():
        messages.append({"role": "system", "content": system.strip()})
    messages.append({"role": "user", "content": contents})
    payload = {
        "model": MODEL,
        "messages": messages,
        "max_tokens": max_tokens or MAX_TOKENS,
        "temperature": temperature,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
        # GPT-OSS defaults to a raw reasoning format, which Groq rejects when
        # JSON mode is enabled. Hide reasoning so the request is valid JSON-only.
        if MODEL.startswith("openai/gpt-oss-"):
            payload["reasoning_format"] = "hidden"
    response = None
    for attempt in range(3):
        response = httpx.post(
            f"{BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=payload,
            timeout=90,
        )
        if response.status_code != 429:
            break

        # Groq includes a precise TPM reset estimate in the error message.
        # Wait only for temporary limits, rather than repeating hard quota errors.
        retry_delays = []
        try:
            retry_delays.append(float(response.headers.get("retry-after", "")))
        except ValueError:
            pass
        try:
            error_data = response.json().get("error", {})
            message = error_data.get("message", "") if isinstance(error_data, dict) else ""
            match = re.search(r"try again in\s+([\d.]+)\s*s", message, re.IGNORECASE)
            if match:
                retry_delays.append(float(match.group(1)))
        except (ValueError, AttributeError):
            pass
        retry_after = max(retry_delays) if retry_delays else None
        if retry_after is None or retry_after > 60 or attempt == 2:
            break
        logger.warning("Groq rate limited the request; retrying in %.1f seconds (attempt %s/2)", retry_after, attempt + 1)
        time.sleep(retry_after + 0.25)

    if response is None:
        raise RuntimeError("Groq did not return a response")
    if not response.is_success:
        message = ""
        try:
            error_data = response.json().get("error", {})
            if isinstance(error_data, dict):
                message = str(error_data.get("message") or "")[:350]
        except (ValueError, AttributeError):
            pass
        detail = f"Groq API returned {response.status_code}"
        if message:
            detail += f": {message}"
        raise httpx.HTTPStatusError(detail, request=response.request, response=response)
    result = response.json()
    return SimpleNamespace(text=result["choices"][0]["message"].get("content", ""))
