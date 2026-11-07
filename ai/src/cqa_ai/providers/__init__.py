"""Provider registry. The project evaluates through NVIDIA's free hosted API."""

from __future__ import annotations

import os

from cqa_ai.providers.base import (
    PermanentProviderError,
    Provider,
    ProviderResponse,
    TransientProviderError,
)

__all__ = [
    "PermanentProviderError",
    "Provider",
    "ProviderResponse",
    "TransientProviderError",
    "get_provider",
    "missing_key",
]

_KEY_VARIABLES = {"nvidia": "NVIDIA_API_KEY"}


def missing_key(name: str) -> str | None:
    """The name of the unset key variable, or None when the provider can start."""
    variable = _KEY_VARIABLES.get(name)
    if variable and not os.environ.get(variable):
        return variable
    return None


def get_provider(name: str) -> Provider:
    if name == "nvidia":
        from cqa_ai.providers.nvidia_provider import NvidiaProvider

        return NvidiaProvider()
    raise ValueError(f"unknown provider {name!r}")
