import asyncio

import pytest
from conftest import model_reply

import cqa_ai.pipeline as pipeline
from cqa_ai import EvaluatorNotConfigured, calculate_score, evaluate, load_default_checklists
from cqa_ai.contracts import EvaluatorConfig, ResultStatus, ReviewStatus
from cqa_ai.pipeline import run_single
from cqa_ai.providers import PermanentProviderError, ProviderResponse, TransientProviderError

CONFIG = EvaluatorConfig(provider="fake", model="main")


class FakeProvider:
    name = "fake"
    cost_per_call = 0.0

    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []

    async def complete(self, *, system, user, schema, config):
        self.calls.append((config.model, user))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return ProviderResponse(text=reply, model=config.model, input_tokens=10, output_tokens=5)


@pytest.fixture(autouse=True)
def no_waiting(monkeypatch):
    monkeypatch.setattr(pipeline, "BASE_BACKOFF_SECONDS", 0)
    monkeypatch.setattr(pipeline, "RATE_LIMIT_WAIT_SECONDS", 0)


def run(chat, checklist, provider, config=CONFIG):
    return asyncio.run(run_single(chat, checklist, config, provider))


def test_success_takes_one_call(chat, checklist):
    provider = FakeProvider(model_reply(checklist))
    output = run(chat, checklist, provider)
    assert len(provider.calls) == 1
    assert output.review_status is ReviewStatus.CLEAR
    assert output.attempts[0].valid and output.attempts[0].cost_usd == 0
    assert calculate_score(checklist, output.results).total == 100


def test_transient_errors_are_retried_and_logged(chat, checklist):
    provider = FakeProvider(
        TransientProviderError("NVIDIA rate limit reached"), model_reply(checklist)
    )
    output = run(chat, checklist, provider)
    assert len(output.attempts) == 2
    assert output.attempts[0].errors and output.attempts[1].valid


def test_a_bad_contract_gets_exactly_one_repair_with_the_reason(chat, checklist):
    provider = FakeProvider(model_reply(checklist, drop={"c05"}), model_reply(checklist))
    output = run(chat, checklist, provider)
    assert len(provider.calls) == 2
    assert "c05: missing from the response" in provider.calls[1][1]
    assert "contract_repair_used" in output.review_reasons
    assert all(r.status is ResultStatus.ASSESSED for r in output.results)


def test_repair_stops_after_one_attempt_and_keeps_the_valid_part(chat, checklist):
    broken = model_reply(checklist, drop={"c05"})
    provider = FakeProvider(broken, broken)
    output = run(chat, checklist, provider)
    assert len(provider.calls) == 2
    statuses = {r.criterion_id: r.status for r in output.results}
    assert statuses["c05"] is ResultStatus.FAILED and statuses["c01"] is ResultStatus.ASSESSED
    score = calculate_score(checklist, output.results)
    assert score.total is None and score.partial_total is not None


def test_total_failure_is_visible_and_not_a_zero(chat, checklist):
    provider = FakeProvider(PermanentProviderError("NVIDIA refused the call, 404: gone"))
    output = run(chat, checklist, provider)
    assert {r.status for r in output.results} == {ResultStatus.FAILED}
    assert "404" in output.results[0].justification
    score = calculate_score(checklist, output.results)
    assert score.total is None and score.partial_total is None


def test_fallback_model_takes_over_and_is_flagged(chat, checklist):
    provider = FakeProvider(PermanentProviderError("gone"), model_reply(checklist))
    config = CONFIG.model_copy(update={"fallback_model": "backup"})
    output = run(chat, checklist, provider, config)
    assert [model for model, _ in provider.calls] == ["main", "backup"]
    assert "served_by_fallback_model" in output.review_reasons
    assert output.review_status is ReviewStatus.FLAGGED
    assert output.attempts[-1].model == "backup"


def test_fallback_is_not_used_when_the_main_model_answers(chat, checklist):
    provider = FakeProvider(model_reply(checklist))
    config = CONFIG.model_copy(update={"fallback_model": "backup"})
    run(chat, checklist, provider, config)
    assert [model for model, _ in provider.calls] == ["main"]


def test_a_rejected_quote_is_dropped_and_flagged_without_a_second_call(chat, checklist):
    bad = model_reply(checklist, {"c01": {"evidence": [{"turn_index": 4, "quote": "нет такого"}]}})
    provider = FakeProvider(bad, model_reply(checklist))
    output = run(chat, checklist, provider)
    assert len(provider.calls) == 1
    c01 = output.results[0]
    assert c01.evidence == [] and "evidence_rejected" in c01.review_flags
    assert c01.answer == "yes"


def test_a_quote_differing_only_in_case_and_punctuation_keeps_the_turn_words(chat, checklist):
    loose = model_reply(checklist, {"c01": {"evidence": [{"turn_index": 4, "quote": "здравствуйте меня зовут анна"}]}})
    output = run(chat, checklist, FakeProvider(loose))
    c01 = output.results[0]
    assert [e.quote for e in c01.evidence] == ["Здравствуйте, меня зовут Анна"]


def test_missing_key_is_reported_as_not_configured(chat, checklist, monkeypatch):
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    with pytest.raises(EvaluatorNotConfigured, match="NVIDIA_API_KEY"):
        asyncio.run(evaluate(chat, checklist, EvaluatorConfig(provider="nvidia", model="m")))


def test_calls_are_not_sent_when_switched_off(call, monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")
    monkeypatch.setenv("CQA_ALLOW_VOICE_TO_CLOUD", "0")
    voice = load_default_checklists()[1]
    output = asyncio.run(evaluate(call, voice, EvaluatorConfig(provider="nvidia", model="m")))
    assert not output.attempts
    assert output.review_reasons == ["personal_data_not_sent"]
    assert {r.status for r in output.results} == {ResultStatus.FAILED}
    assert calculate_score(voice, output.results).partial_total is None


def test_the_signed_audio_url_never_reaches_the_prompt(call):
    voice = load_default_checklists()[1]
    evidence = [{"turn_index": 2, "quote": "Здравствуйте"}]
    reply = model_reply(voice, {c.id: {"evidence": evidence} for c in voice.criteria})
    provider = FakeProvider(reply)
    asyncio.run(run_single(call, voice, CONFIG, provider))
    assert "sig=" not in provider.calls[0][1]
