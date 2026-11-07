"""OpenAI-compatible endpoints the evaluator can call, with their limits and prices.

A model is addressed as `provider:model`, e.g. `nvidia:google/gemma-4-31b-it` or
`local:qwen3:4b`. Only the part before the first colon is the provider, and only
when it names a profile below, so Ollama tags such as `qwen3:4b` stay intact.

Limits are the documented free-tier values and are deliberately conservative:
NVIDIA advertises about 40 RPM but slows down under load.

`PAID_EQUIVALENT` is what the same call would cost on a paid provider. The team
uses free endpoints only, so `cost_usd` stays 0; this number shows the solution
stays cheap if it ever moves to a paid tier. Source: public OpenRouter catalog,
`GET https://openrouter.ai/api/v1/models`, read 2026-11-07, USD per 1M tokens.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class ProviderProfile:
    name: str
    base_url: str
    key_env: str | None
    # Structured-output modes, tried in order until the endpoint accepts one.
    json_modes: tuple[str, ...]
    rpm: int
    tpm: int | None = None
    rpd: int | None = None
    # May real voice calls (personal data) be sent here?
    allows_personal_data: bool = False
    price_in_per_mtok: float = 0.0
    price_out_per_mtok: float = 0.0
    base_url_env: str | None = None
    notes: str = ""
    extra: dict[str, str] = field(default_factory=dict)

    def url(self) -> str:
        if self.base_url_env and os.environ.get(self.base_url_env):
            return os.environ[self.base_url_env]
        return self.base_url

    def key(self) -> str:
        if self.key_env is None:
            return "not-needed"
        return os.environ.get(self.key_env, "")


PROFILES: dict[str, ProviderProfile] = {
    profile.name: profile
    for profile in (
        ProviderProfile(
            name="nvidia",
            base_url="https://integrate.api.nvidia.com/v1",
            key_env="NVIDIA_API_KEY",
            json_modes=("guided_json", "response_format", "prompt_only"),
            rpm=int(os.environ.get("NVIDIA_RPM", "35")),
            notes="Free build.nvidia.com tier. Logs requests: no real calls.",
        ),
        ProviderProfile(
            name="local",
            base_url="http://127.0.0.1:11434/v1",
            base_url_env="LOCAL_LLM_BASE_URL",
            key_env=None,
            json_modes=("response_format", "prompt_only"),
            rpm=int(os.environ.get("LOCAL_RPM", "600")),
            allows_personal_data=True,
            notes="Ollama or vLLM on this machine. Data never leaves it.",
        ),
        ProviderProfile(
            name="groq",
            base_url="https://api.groq.com/openai/v1",
            key_env="GROQ_API_KEY",
            json_modes=("response_format", "prompt_only"),
            rpm=30,
            notes="Free tier, per-model RPM/TPM/RPD. Not configured by the team.",
        ),
        ProviderProfile(
            name="cerebras",
            base_url="https://api.cerebras.ai/v1",
            key_env="CEREBRAS_API_KEY",
            json_modes=("response_format", "prompt_only"),
            rpm=30,
            notes="Free tier, strict TPM. Not configured by the team.",
        ),
        ProviderProfile(
            name="openrouter",
            base_url="https://openrouter.ai/api/v1",
            key_env="OPENROUTER_API_KEY",
            json_modes=("response_format", "prompt_only"),
            rpm=20,
            notes="`:free` models only. Not configured by the team.",
        ),
        ProviderProfile(
            name="gemini",
            base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
            key_env="GEMINI_API_KEY",
            json_modes=("response_format", "prompt_only"),
            rpm=10,
            notes="AI Studio free tier may train on data: no real calls.",
        ),
    )
}

# model id (without provider prefix) -> (input, output) USD per 1M tokens
PAID_EQUIVALENT: dict[str, tuple[float, float]] = {
    "google/gemma-4-31b-it": (0.20, 0.40),
    "mistralai/mistral-large-4-1t-a52b": (0.70, 2.10),
    "nvidia/nemotron-3-ultra-550b-a55b": (0.60, 2.40),
    "nvidia/nemotron-3-super-120b-a12b": (0.075, 0.40),
    "nvidia/nemotron-3.5-lightning-30b-a3b": (0.07, 0.20),
    "nvidia/nemotron-3.5-super-vl-120b-a12b": (0.15, 0.50),
    "deepseek-ai/deepseek-v4.1-flash": (0.051, 0.567),
    "minimaxai/minimax-m3.1-flash": (0.075, 0.30),
    "moonshotai/kimi-k2.6": (0.65, 3.41),
    "openai/gpt-oss-20b": (0.03, 0.13),
}
PRICE_SOURCE = "openrouter.ai/api/v1/models, 2026-11-07"


def split_model(spec: str, default_provider: str) -> tuple[str, str]:
    """`nvidia:google/gemma-4-31b-it` -> ("nvidia", "google/gemma-4-31b-it")."""
    prefix, sep, rest = spec.partition(":")
    if sep and prefix in PROFILES:
        return prefix, rest
    return default_provider, spec


def paid_equivalent_usd(model: str, input_tokens: int | None, output_tokens: int | None) -> float | None:
    prices = PAID_EQUIVALENT.get(model)
    if prices is None or input_tokens is None or output_tokens is None:
        return None
    return round((input_tokens * prices[0] + output_tokens * prices[1]) / 1_000_000, 6)
