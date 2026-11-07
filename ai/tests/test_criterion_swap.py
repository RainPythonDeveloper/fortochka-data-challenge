"""W8: organizers replace a criterion through the UI. Nothing in code may need to change.

Each case edits the default checklist as the UI would, then checks that prompt,
schema, validator and scoring all follow the new data, and that notes written
for the old meaning stop reaching the model.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from conftest import model_reply

import cqa_ai.pipeline as pipeline
from cqa_ai import calculate_score
from cqa_ai.annotate import annotate
from cqa_ai.contracts import (
    Criterion,
    CriterionType,
    EvaluatorConfig,
    ResultStatus,
    ScaleLevel,
    Section,
)
from cqa_ai.pipeline import run_single
from cqa_ai.prompt import build_prompt
from cqa_ai.providers import ProviderResponse
from cqa_ai.rubric import allowed_answers, effective_notes, response_schema

CONFIG = EvaluatorConfig(provider="fake", model="main")


class FakeProvider:
    name = "fake"
    cost_per_call = 0.0

    def __init__(self, *replies: str) -> None:
        self.replies = list(replies)
        self.prompts: list[tuple[str, str]] = []

    async def complete(self, *, system, user, schema, config):  # noqa: ANN001
        self.prompts.append((system, user))
        return ProviderResponse(text=self.replies.pop(0), model=config.model)


@pytest.fixture(autouse=True)
def no_waiting(monkeypatch):
    monkeypatch.setattr(pipeline, "BASE_BACKOFF_SECONDS", 0)


def _replace(checklist, criterion_id: str, new: Criterion):
    edited = checklist.model_copy(deep=True)
    edited.criteria = [new if c.id == criterion_id else c for c in edited.criteria]
    edited.version += 1
    return edited


def _run(chat, checklist, *replies):
    provider = FakeProvider(*replies)
    output = asyncio.run(run_single(chat, checklist, CONFIG, provider))
    return output, provider


def _answer(output, criterion_id):
    return next(r for r in output.results if r.criterion_id == criterion_id)


def test_1_new_binary_criterion_replaces_c05(chat, checklist):
    old_notes = effective_notes(next(c for c in checklist.criteria if c.id == "c05"))
    new = Criterion(
        id="c05",
        section="s3",
        title="Предложение оценить консультацию",
        type=CriterionType.BOOLEAN,
        weight=15,
        yes_when="оператор предложил клиенту оценить качество консультации",
    )
    edited = _replace(checklist, "c05", new)

    # Same id, new meaning: the notes written for empathy must not follow it.
    assert effective_notes(next(c for c in edited.criteria if c.id == "c05")) == []
    system = build_prompt(chat, edited, annotate(chat)).system
    assert "оценить качество консультации" in system
    assert "Эмпатия" not in system
    assert not any(note in system for note in old_notes)

    output, _ = _run(chat, edited, model_reply(edited, {"c05": {"answer": "no"}}))
    assert _answer(output, "c05").answer == "no"
    assert calculate_score(edited, output.results).total == pytest.approx(85.0)


def test_2_new_three_step_scale_replaces_c06(chat, checklist):
    new = Criterion(
        id="c06",
        section="s3",
        title="Грамотность",
        type=CriterionType.SCALE,
        weight=15,
        prompt="Оцените грамотность письма оператора.",
        levels=[
            ScaleLevel(value=5, text="Без ошибок"),
            ScaleLevel(value=3, text="Есть ошибки, смысл понятен"),
            ScaleLevel(value=0, text="Ошибки мешают понять"),
        ],
    )
    edited = _replace(checklist, "c06", new)
    criterion = next(c for c in edited.criteria if c.id == "c06")
    assert allowed_answers(criterion) == ["5", "3", "0"]
    enum = response_schema(edited)["properties"]["results"]["items"]["properties"]["answer"]["enum"]
    assert "3" in enum and "5" in enum

    # A level of the old scale is now invalid and costs one repair, never a silent pass.
    output, provider = _run(
        chat,
        edited,
        model_reply(edited, {"c06": {"answer": "7"}}),
        model_reply(edited, {"c06": {"answer": "3"}}),
    )
    assert len(provider.prompts) == 2
    assert _answer(output, "c06").answer == 3
    # 3 of 5 is 60 % of the weight: 100 - 15 * 0.4 = 94
    assert calculate_score(edited, output.results).total == pytest.approx(94.0)


def test_3_weight_change_only_rescores_without_the_model(chat, checklist):
    output, _ = _run(chat, checklist, model_reply(checklist, {"c01": {"answer": "no"}}))
    before = calculate_score(checklist, output.results).total
    reweighted = checklist.model_copy(deep=True)
    next(c for c in reweighted.criteria if c.id == "c01").weight = 30
    after = calculate_score(reweighted, output.results).total
    assert before == pytest.approx(90.0)
    assert after == pytest.approx(75.0)  # 90 of 120
    facts = annotate(chat)
    assert build_prompt(chat, checklist, facts).prompt_hash == build_prompt(
        chat, reweighted, facts
    ).prompt_hash


def test_4_switching_off_na_for_c07(chat, checklist):
    edited = checklist.model_copy(deep=True)
    c07 = next(c for c in edited.criteria if c.id == "c07")
    c07.allow_na = False
    c07.na_when = None
    assert "na" not in allowed_answers(c07)

    output, provider = _run(
        chat,
        edited,
        model_reply(edited, {"c07": {"answer": "na"}}),
        model_reply(edited, {"c07": {"answer": "no"}}),
    )
    assert len(provider.prompts) == 2
    assert _answer(output, "c07").status is ResultStatus.ASSESSED
    assert _answer(output, "c07").answer == "no"


def test_5_new_criterion_in_a_new_section(chat, checklist):
    edited = checklist.model_copy(deep=True)
    edited.sections.append(Section(id="s5", title="Продажи"))
    edited.criteria.append(
        Criterion(
            id="c09",
            section="s5",
            title="Предложение продукта",
            type=CriterionType.BOOLEAN,
            weight=10,
            yes_when="оператор уместно предложил продукт компании",
        )
    )
    system = build_prompt(chat, edited, annotate(chat)).system
    assert "Продажи" in system and "c09" in system

    output, _ = _run(chat, edited, model_reply(edited, {"c09": {"answer": "no"}}))
    assert _answer(output, "c09").answer == "no"
    summary = calculate_score(edited, output.results)
    assert summary.total == pytest.approx(round(100 * 100 / 110, 2))
    payload = json.loads(summary.model_dump_json())
    assert any(section["section_id"] == "s5" for section in payload["sections"])
