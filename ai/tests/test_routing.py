"""Where a conversation is allowed to go. Real calls carry personal data."""

from __future__ import annotations

import asyncio

import pytest

import cqa_ai.service as service
import cqa_ai.strategies as strategies
from cqa_ai import evaluate, load_default_checklists
from cqa_ai.contracts import EvaluationOutput, EvaluatorConfig, ResultStatus


@pytest.fixture
def seen(monkeypatch):
    calls = []

    async def fake_single(snapshot, checklist, config, provider, fallback_provider=None, **_):
        calls.append(
            {
                "provider": provider.name,
                "model": config.model,
                "fallback_provider": fallback_provider.name if fallback_provider else None,
                "fallback_model": config.fallback_model,
            }
        )
        return EvaluationOutput(results=[])

    monkeypatch.setattr(service, "run_single", fake_single)
    monkeypatch.setattr(strategies, "run_single", fake_single)
    monkeypatch.setenv("NVIDIA_API_KEY", "x")
    monkeypatch.delenv("LLM_FALLBACK_MODEL", raising=False)
    monkeypatch.delenv("CQA_ALLOW_VOICE_TO_CLOUD", raising=False)
    return calls


def voice():
    return next(c for c in load_default_checklists() if "voice call" in c.channels)


def run(snapshot, checklist, **config):
    return asyncio.run(evaluate(snapshot, checklist, EvaluatorConfig(provider="nvidia", **config)))


def test_call_on_local_never_falls_back_to_the_cloud(seen, call):
    run(call, voice(), model="local:qwen3:4b", fallback_model="nvidia:google/gemma-4-31b-it")
    assert seen == [
        {"provider": "local", "model": "qwen3:4b", "fallback_provider": None, "fallback_model": ""}
    ]


def test_call_on_cloud_moves_to_a_local_fallback(seen, call):
    run(call, voice(), model="google/gemma-4-31b-it", fallback_model="local:qwen3:4b")
    assert seen[0]["provider"] == "local" and seen[0]["model"] == "qwen3:4b"


def test_call_on_cloud_without_local_is_blocked_not_sent(seen, call):
    output = run(call, voice(), model="google/gemma-4-31b-it", fallback_model="")
    assert seen == []
    assert all(r.status is ResultStatus.FAILED for r in output.results)
    assert "personal_data_not_sent" in output.review_reasons


def test_explicit_switch_allows_the_cloud(seen, call, monkeypatch):
    monkeypatch.setenv("CQA_ALLOW_VOICE_TO_CLOUD", "1")
    run(call, voice(), model="google/gemma-4-31b-it", fallback_model="")
    assert seen[0]["provider"] == "nvidia"


def test_chat_keeps_a_cross_provider_fallback(seen, chat, checklist):
    run(chat, checklist, model="local:qwen3:4b", fallback_model="nvidia:google/gemma-4-31b-it")
    assert seen[0]["fallback_provider"] == "nvidia"


def test_bare_fallback_belongs_to_llm_provider_not_to_the_primary_prefix(seen, chat, checklist):
    run(chat, checklist, model="local:qwen3:4b", fallback_model="google/gemma-4-31b-it")
    assert seen[0]["fallback_provider"] == "nvidia"
    assert seen[0]["fallback_model"] == "google/gemma-4-31b-it"


def test_fallback_without_a_key_is_dropped(seen, chat, checklist, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    run(chat, checklist, model="google/gemma-4-31b-it", fallback_model="groq:llama-x")
    assert seen[0]["fallback_provider"] is None and seen[0]["fallback_model"] == ""
