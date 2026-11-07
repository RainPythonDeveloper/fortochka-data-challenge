"""Provider registry: every OpenAI-compatible endpoint described in `profiles.py`."""

from __future__ import annotations

from cqa_ai.providers.base import (
    PermanentProviderError,
    Provider,
    ProviderResponse,
    TransientProviderError,
)
from cqa_ai.providers.profiles import PROFILES, split_model

__all__ = [
    "PROFILES",
    "PermanentProviderError",
    "Provider",
    "ProviderResponse",
    "TransientProviderError",
    "get_provider",
    "missing_key",
    "split_model",
]


def missing_key(name: str) -> str | None:
    """The name of the unset key variable, or None when the provider can start."""
    profile = PROFILES.get(name)
    if profile is None or profile.key_env is None:
        return None
    return None if profile.key() else profile.key_env


def get_provider(name: str) -> Provider:
    if name == "nvidia":
        from cqa_ai.providers.nvidia_provider import NvidiaProvider

        return NvidiaProvider()
    if name in PROFILES:
        from cqa_ai.providers.openai_compat import OpenAICompatProvider

        return OpenAICompatProvider(PROFILES[name])
    raise ValueError(f"unknown provider {name!r}")
