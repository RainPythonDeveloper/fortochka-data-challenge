"""The provider boundary. The pipeline depends on this and on nothing vendor-specific."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from cqa_ai.contracts import EvaluatorConfig


class TransientProviderError(RuntimeError):
    """Worth retrying: rate limits, overload, network failures, hangs."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class PermanentProviderError(RuntimeError):
    """Retrying the same request cannot help."""


@dataclass
class ProviderResponse:
    text: str
    model: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    truncated: bool = False


class Provider(Protocol):
    name: str
    # Free endpoints cost nothing, so a run can report 0 instead of an unknown price.
    cost_per_call: float | None

    async def complete(
        self, *, system: str, user: str, schema: dict[str, Any], config: EvaluatorConfig
    ) -> ProviderResponse: ...
