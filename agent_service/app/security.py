import hmac
import os
import re
from fastapi import Header, HTTPException

_SECRET_NAME = r"(?:[A-Za-z0-9_-]*)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|private[_-]?key)"
_QUOTED_SECRET = re.compile(rf"(?i)({_SECRET_NAME}\s*[:=]\s*)(['\"])(.*?)(\2)")
_UNQUOTED_SECRET = re.compile(rf"(?i)({_SECRET_NAME}\s*[:=]\s*)([^\s,;#]{16,})")
_PEM_PRIVATE_KEY = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----")
_TOKEN_PATTERNS = (
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bAIza[A-Za-z0-9_-]{30,}\b"),
    re.compile(r"\bAKIA[A-Z0-9]{16}\b"),
    re.compile(r"(?i)(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}"),
)


def redact_repository_content(content: str) -> str:
    """Remove common credential values before repository text reaches the LLM/RAG store."""
    content = _PEM_PRIVATE_KEY.sub("[REDACTED PRIVATE KEY]", content)
    content = _QUOTED_SECRET.sub(r"\1\2[REDACTED]\4", content)
    content = _UNQUOTED_SECRET.sub(r"\1[REDACTED]", content)
    for pattern in _TOKEN_PATTERNS:
        content = pattern.sub(lambda match: f"{match.group(1)}[REDACTED]" if match.lastindex else "[REDACTED]", content)
    return content

async def require_service_token(x_agent_token: str | None = Header(default=None)) -> None:
    expected = os.environ.get("AGENT_SERVICE_TOKEN", "")
    if not expected or not x_agent_token or not hmac.compare_digest(expected, x_agent_token):
        raise HTTPException(status_code=401, detail="Unauthorized service request")
