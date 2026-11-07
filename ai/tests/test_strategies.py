"""W4/W5: pipeline variants and judge ensembles on synthetic data."""

from __future__ import annotations

import asyncio
import json

import pytest
from conftest import model_reply

from cqa_ai import evaluate
from cqa_ai.contracts import EvaluatorConfig, ResultStatus
from cqa_ai.providers import ProviderResponse
from cqa_ai.strategies import (
    run_per_criterion,
    run_sections,
    run_two_judges,
    run_vote,
    subchecklist,
)


class ScriptedProvider:
    """Answers with `model_reply` for whatever criteria the schema asks about."""

    cost_per_call = 0.0

    def __init__(self, name="fake", overrides=None, sequence=None):
        self.name = name
        self.overrides = overrides or {}
        self.sequence = list(sequence or [])
        self.users: list[str] = []
        self.schemas: list[list[str]] = []

    async def complete(self, *, system, user, schema, config):
        ids = schema["properties"]["results"]["items"]["properties"]["criterion_id"]["enum"]
        self.users.append(user)
        self.schemas.append(ids)
        overrides = self.sequence.pop(0) if self.sequence else self.overrides
        items = json.loads(model_reply(_FULL, overrides))["results"]
        text = json.dumps({"results": [i for i in items if i["criterion_id"] in ids]})
        return ProviderResponse(text=text, model=config.model)


_FULL = None


@pytest.fixture(autouse=True)
def full_checklist(checklist):
    global _FULL
    _FULL = checklist


CONFIG = EvaluatorConfig(provider="fake", model="judge-a")


def answers(output):
    return {r.criterion_id: (r.answer if r.status is ResultStatus.ASSESSED else r.status.value)
            for r in output.results}


def test_subchecklist_keeps_only_needed_sections(checklist):
    sub = subchecklist(checklist, ["c06", "c07"])
    assert [c.id for c in sub.criteria] == ["c06", "c07"]
    assert {s.id for s in sub.sections} == {"s3"}


def test_sections_makes_one_call_per_section_and_merges(chat, checklist):
    provider = ScriptedProvider()
    output = asyncio.run(run_sections(chat, checklist, CONFIG, provider))
    assert len(provider.schemas) == len(checklist.sections)
    assert [r.criterion_id for r in output.results] == [c.id for c in checklist.criteria]


def test_per_criterion_makes_one_call_per_criterion(chat, checklist):
    provider = ScriptedProvider()
    output = asyncio.run(run_per_criterion(chat, checklist, CONFIG, provider))
    assert sorted(ids[0] for ids in provider.schemas) == sorted(c.id for c in checklist.criteria)
    assert len(output.results) == len(checklist.criteria)


def test_two_judges_agree_without_arbiter(chat, checklist):
    a, b = ScriptedProvider("a"), ScriptedProvider("b")
    output = asyncio.run(
        run_two_judges(
            chat, checklist,
            CONFIG.model_copy(update={"second_model": "judge-b"}),
            a, provider_for=lambda spec: (b, spec),
        )
    )
    assert len(a.users) == 1 and len(b.users) == 1
    assert all(r.confidence == 1.0 and len(r.votes) == 2 for r in output.results)
    assert "judges_disagreed" not in output.review_reasons


def test_two_judges_disagree_and_the_arbiter_decides_only_conflicts(chat, checklist):
    a = ScriptedProvider("a", {"c07": {"answer": "yes"}})
    b = ScriptedProvider("b", {"c07": {"answer": "no"}})
    arbiter = ScriptedProvider("arb", {"c07": {"answer": "no"}})
    providers = {"judge-b": b, "judge-arb": arbiter}
    output = asyncio.run(
        run_two_judges(
            chat, checklist,
            CONFIG.model_copy(update={"second_model": "judge-b", "arbiter_model": "judge-arb"}),
            a, provider_for=lambda spec: (providers[spec], spec),
        )
    )
    assert arbiter.schemas == [["c07"]]
    assert "судья 1" in arbiter.users[0] and "судья 2" in arbiter.users[0]
    c07 = next(r for r in output.results if r.criterion_id == "c07")
    assert c07.answer == "no" and "arbitrated" in c07.review_flags
    assert [v.answer for v in c07.votes] == ["yes", "no", "no"]
    assert c07.confidence == 0.67
    assert "judges_disagreed" in output.review_reasons


def test_vote_takes_majority_and_scale_median(chat, checklist):
    provider = ScriptedProvider(
        sequence=[
            {"c06": {"answer": "10"}, "c07": {"answer": "no"}},
            {"c06": {"answer": "4"}, "c07": {"answer": "yes"}},
            {"c06": {"answer": "7"}, "c07": {"answer": "no"}},
        ]
    )
    output = asyncio.run(
        run_vote(chat, checklist, CONFIG.model_copy(update={"votes": 3}), provider)
    )
    got = answers(output)
    assert got["c07"] == "no"
    assert got["c06"] == 7  # no majority: median of 10, 4, 7
    c07 = next(r for r in output.results if r.criterion_id == "c07")
    assert c07.confidence == 0.67


def test_voice_call_never_reaches_a_second_judge_that_may_not_see_it(monkeypatch, call):
    monkeypatch.setenv("NVIDIA_API_KEY", "x")
    monkeypatch.setenv("CQA_ALLOW_VOICE_TO_CLOUD", "0")
    seen = []

    async def fake_single(snapshot, checklist, config, provider, *args, **kwargs):
        seen.append(provider.name)
        raise RuntimeError("stop")

    import cqa_ai.strategies as strategies

    monkeypatch.setattr(strategies, "run_single", fake_single)
    from cqa_ai import load_default_checklists

    voice = next(c for c in load_default_checklists() if "voice call" in c.channels)
    config = EvaluatorConfig(
        provider="local", model="qwen3:4b", pipeline="two_judges",
        second_model="nvidia:google/gemma-4-31b-it", fallback_model="",
    )
    with pytest.raises(RuntimeError):
        asyncio.run(evaluate(call, voice, config))
    # two_judges degraded to single on the local model; NVIDIA never called.
    assert "nvidia" not in seen


def test_second_opinion_rechecks_only_chosen_criteria_and_arbitrates(chat, checklist):
    from cqa_ai.strategies import run_second_opinion

    first = ScriptedProvider("a", {"c07": {"answer": "yes"}})
    second = ScriptedProvider("b", {"c07": {"answer": "no"}})
    arbiter = ScriptedProvider("arb", {"c07": {"answer": "no"}})
    providers = {"judge-b": second, "judge-arb": arbiter}
    config = CONFIG.model_copy(
        update={
            "second_model": "judge-b",
            "arbiter_model": "judge-arb",
            "second_criteria": ["c07", "c08", "c99"],  # c99 is not in the checklist: ignored
        }
    )
    output = asyncio.run(
        run_second_opinion(chat, checklist, config, first, provider_for=lambda s: (providers[s], s))
    )
    assert second.schemas == [["c07", "c08"]]
    assert arbiter.schemas == [["c07"]]
    got = answers(output)
    assert got["c07"] == "no"
    c08 = next(r for r in output.results if r.criterion_id == "c08")
    assert len(c08.votes) == 2 and c08.confidence == 1.0
    c01 = next(r for r in output.results if r.criterion_id == "c01")
    assert c01.votes is None  # not re-checked
    assert "judges_disagreed" in output.review_reasons


def test_second_opinion_defaults_to_violation_flags(chat, checklist):
    from cqa_ai.strategies import run_second_opinion

    first, second = ScriptedProvider("a"), ScriptedProvider("b")
    config = CONFIG.model_copy(update={"second_model": "judge-b"})
    asyncio.run(run_second_opinion(chat, checklist, config, first, provider_for=lambda s: (second, s)))
    assert second.schemas == [[c.id for c in checklist.criteria if c.flag]]


def test_self_check_sends_traps_and_flags_changes(chat, checklist):
    from cqa_ai.strategies import run_self_check

    provider = ScriptedProvider(sequence=[{"c07": {"answer": "yes"}}, {"c07": {"answer": "no"}}])
    output = asyncio.run(run_self_check(chat, checklist, CONFIG, provider))
    assert len(provider.users) == 2
    assert "САМОПРОВЕРКА" in provider.users[1] and "Частые ловушки" in provider.users[1]
    c07 = next(r for r in output.results if r.criterion_id == "c07")
    assert c07.answer == "no" and "self_check_changed" in c07.review_flags
    assert c07.confidence == 0.5 and "low_confidence" in c07.review_flags


def test_facts_first_extracts_then_grades_with_the_facts(chat, checklist):
    from cqa_ai.strategies import run_facts_first

    facts = {
        "client_questions": [{"turn": 0, "question": "где тариф", "answered": "yes", "answer_turn": 4}],
        "wait_requests": [], "identity_check_turn": -1, "disclosed_account_data_turns": [],
        "operator_contradictions": [], "client_repeats": [],
        "closing": {"turn": 6, "summary": "no", "offer_of_help": "no", "farewell": "yes"},
    }

    class TwoStep(ScriptedProvider):
        async def complete(self, *, system, user, schema, config):
            if "client_questions" in schema.get("properties", {}):
                self.users.append(user)
                return ProviderResponse(text=json.dumps(facts, ensure_ascii=False), model=config.model)
            return await super().complete(system=system, user=user, schema=schema, config=config)

    provider = TwoStep()
    output = asyncio.run(run_facts_first(chat, checklist, CONFIG, provider))
    assert output.extracted_facts == facts
    assert "ФАКТЫ, ИЗВЛЕЧЁННЫЕ ПЕРВЫМ ПРОХОДОМ" in provider.users[-1]
    assert "Вопрос клиента [0]" in provider.users[-1]
    assert [a.role for a in output.attempts][:1] == ["facts"]
    assert len(output.results) == len(checklist.criteria)


def test_facts_first_survives_a_broken_extraction(chat, checklist):
    from cqa_ai.strategies import run_facts_first

    class Broken(ScriptedProvider):
        async def complete(self, *, system, user, schema, config):
            if "client_questions" in schema.get("properties", {}):
                return ProviderResponse(text="not json", model=config.model)
            return await super().complete(system=system, user=user, schema=schema, config=config)

    output = asyncio.run(run_facts_first(chat, checklist, CONFIG, Broken()))
    assert output.extracted_facts is None
    assert "facts_unavailable" in output.review_reasons
    assert all(r.status is ResultStatus.ASSESSED or r.status is ResultStatus.NOT_APPLICABLE for r in output.results)


def test_facts_first_survives_a_malformed_extraction_shape(chat, checklist):
    from cqa_ai.strategies import run_facts_first

    bad = {"client_questions": "x", "closing": "yes", "identity_check_turn": None}

    class Odd(ScriptedProvider):
        async def complete(self, *, system, user, schema, config):
            if "client_questions" in schema.get("properties", {}):
                return ProviderResponse(text=json.dumps(bad), model=config.model)
            return await super().complete(system=system, user=user, schema=schema, config=config)

    output = asyncio.run(run_facts_first(chat, checklist, CONFIG, Odd()))
    assert output.extracted_facts is None
    assert "facts_unavailable" in output.review_reasons
    assert len(output.results) == len(checklist.criteria)
