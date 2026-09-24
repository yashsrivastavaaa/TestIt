import os
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


def generate_text(
    *,
    contents: str,
    system: str | None = None,
    api_key: str | None = None,
    json_mode: bool = False,
    temperature: float = 0.1,
    max_tokens: int | None = None,
):
    key = (api_key or os.environ.get("GROQ_API_KEY") or "").strip()
    if not key:
        # An empty process variable should not hide a populated service .env.
        key = str(dotenv_values(SERVICE_ENV).get("GROQ_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("Groq is not configured. Set GROQ_API_KEY in agent_service/.env and restart the agent service.")

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
    response = httpx.post(
        f"{BASE_URL}/chat/completions",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json=payload,
        timeout=90,
    )
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
