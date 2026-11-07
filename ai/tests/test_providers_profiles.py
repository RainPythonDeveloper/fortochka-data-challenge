"""W1: provider profiles, `provider:model` addressing, rate limiting and pricing."""

from __future__ import annotations

import asyncio
import time

import pytest

from cqa_ai.providers import PROFILES, get_provider, missing_key, split_model
from cqa_ai.providers.openai_compat import OpenAICompatProvider
from cqa_ai.providers.profiles import paid_equivalent_usd
from cqa_ai.providers.ratelimit import RateLimiter


@pytest.mark.parametrize(
    ("spec", "expected"),
    [
        ("nvidia:google/gemma-4-31b-it", ("nvidia", "google/gemma-4-31b-it")),
        ("local:qwen3:4b", ("local", "qwen3:4b")),
        ("google/gemma-4-31b-it", ("nvidia", "google/gemma-4-31b-it")),
        # An Ollama tag without a provider prefix must stay whole.
        ("qwen3:4b", ("nvidia", "qwen3:4b")),
        ("openrouter:google/gemma-4-31b-it:free", ("openrouter", "google/gemma-4-31b-it:free")),
    ],
)
def test_split_model(spec, expected):
    assert split_model(spec, "nvidia") == expected


def test_every_profile_builds_a_provider(monkeypatch):
    for name, profile in PROFILES.items():
        if profile.key_env:
            monkeypatch.setenv(profile.key_env, "test-key")
        provider = get_provider(name)
        assert provider.name == name


def test_local_needs_no_key_and_may_take_personal_data(monkeypatch):
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    assert missing_key("local") is None
    assert missing_key("nvidia") == "NVIDIA_API_KEY"
    assert get_provider("local").allows_personal_data is True
    assert PROFILES["nvidia"].allows_personal_data is False


def test_free_provider_costs_zero_and_reports_paid_equivalent(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")
    provider = get_provider("nvidia")
    cost, paid = provider.cost_of("google/gemma-4-31b-it", 3_500, 1_500)
    assert cost == 0.0
    # 3500 * 0.20 + 1500 * 0.40 per million tokens
    assert paid == pytest.approx(0.0013)


def test_unknown_model_has_no_paid_equivalent():
    assert paid_equivalent_usd("someone/unknown", 10, 10) is None
    assert paid_equivalent_usd("google/gemma-4-31b-it", None, 10) is None


def test_local_base_url_can_be_overridden(monkeypatch):
    monkeypatch.setenv("LOCAL_LLM_BASE_URL", "http://10.0.0.5:8001/v1")
    assert PROFILES["local"].url() == "http://10.0.0.5:8001/v1"
    provider = OpenAICompatProvider(PROFILES["local"])
    assert str(provider._client.base_url).startswith("http://10.0.0.5:8001/v1")


def test_rate_limiter_spaces_requests():
    async def burst() -> list[int]:
        limiter = RateLimiter(rpm=600)  # 0.1 s apart
        return await asyncio.gather(*(limiter.acquire() for _ in range(4)))

    started = time.monotonic()
    waits = asyncio.run(burst())
    elapsed = time.monotonic() - started
    assert elapsed >= 0.28
    assert sorted(waits)[0] < 50
    assert sorted(waits)[-1] >= 250


def test_local_profile_on_a_remote_host_may_not_see_calls(monkeypatch):
    monkeypatch.setenv("LOCAL_LLM_BASE_URL", "http://10.0.0.5:8001/v1")
    assert OpenAICompatProvider(PROFILES["local"]).allows_personal_data is False
    monkeypatch.setenv("LOCAL_LLM_BASE_URL", "http://127.0.0.1:11434/v1")
    assert OpenAICompatProvider(PROFILES["local"]).allows_personal_data is True
