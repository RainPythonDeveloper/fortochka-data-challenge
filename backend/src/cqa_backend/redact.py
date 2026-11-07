"""Masking of signed URLs and keys in logs and error messages.

The API URL and every `audio_url` carry a signature, so a URL is masked as a whole
wherever it shows up, including inside messages produced by the HTTP client.
"""

from __future__ import annotations

import logging
import re
import traceback

MASK = "[masked]"
_PATTERNS = (
    re.compile(r"[a-z][a-z0-9+.-]*://[^\s\"'<>]+", re.IGNORECASE),
    re.compile(r"\b(sig|signature|token|api[-_]?key)=[^&\s\"'<>]+", re.IGNORECASE),
    re.compile(r"\b(sk|nvapi)-[A-Za-z0-9_-]{8,}"),
)
_secrets: set[str] = set()


def register_secret(value: str | None) -> None:
    if value:
        _secrets.add(value)


def redact(text: object) -> str:
    result = str(text)
    for secret in _secrets:
        result = result.replace(secret, MASK)
    for pattern in _PATTERNS:
        result = pattern.sub(MASK, result)
    return result


class RedactingFilter(logging.Filter):
    """Handler filter. With args the message is a format string from the code, so
    only the args are masked. They stay a tuple: the uvicorn access formatter unpacks it."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple) and record.args:
            record.args = tuple(
                arg if isinstance(arg, (int, float)) else redact(arg) for arg in record.args
            )
        elif not record.args:
            record.msg = redact(record.msg)
        if record.exc_info and record.exc_info[0]:
            record.exc_text = redact("".join(traceback.format_exception(*record.exc_info)))
            record.exc_info = None
        return True


def setup_logging() -> None:
    logging.getLogger("httpx").setLevel(logging.WARNING)  # logs full URLs at INFO
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    for name in (None, "uvicorn", "uvicorn.error", "uvicorn.access"):
        for handler in logging.getLogger(name).handlers:
            if not any(isinstance(item, RedactingFilter) for item in handler.filters):
                handler.addFilter(RedactingFilter())
