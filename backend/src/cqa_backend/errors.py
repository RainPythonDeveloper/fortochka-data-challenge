"""Errors that map directly to the `{"detail": "..."}` response."""

from __future__ import annotations

from pydantic import ValidationError


class ApiError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def describe_validation(exc: ValidationError) -> str:
    """Location and reason only: the default text quotes the input values."""
    parts = [
        f"{'.'.join(str(item) for item in error['loc'])}: {error['msg']}".lstrip(": ")
        for error in exc.errors(include_input=False, include_url=False, include_context=False)
    ]
    return "; ".join(parts)
