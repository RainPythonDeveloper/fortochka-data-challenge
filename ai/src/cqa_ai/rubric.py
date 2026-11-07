"""Turns a checklist version into model-facing text and a response schema.

Everything is derived from the checklist data, so a criterion added or replaced
in the UI reaches the model with no code change. Weights are deliberately left
out: they do not affect the decision, and changing one must not change the prompt.
"""

from __future__ import annotations

import hashlib
import json
from functools import cache
from importlib import resources
from typing import Any

from cqa_ai.contracts import ChecklistVersion, Criterion, CriterionType

NA_ANSWER = "na"
UNASSESSABLE_ANSWER = "unassessable"


def meaning_fingerprint(criterion: Criterion) -> str:
    """Identifies what a criterion means. Its id is not a guarantee of that."""
    payload = criterion.model_dump(
        mode="json",
        include={"title", "type", "allow_na", "yes_when", "prompt", "na_when", "levels", "flag"},
    )
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


@cache
def _default_notes() -> tuple[dict[str, tuple[str, ...]], frozenset[str]]:
    by_meaning: dict[str, tuple[str, ...]] = {}
    every_note: set[str] = set()
    folder = resources.files("cqa_ai") / "checklists"
    for item in folder.iterdir():
        if not item.name.endswith(".json"):
            continue
        checklist = ChecklistVersion.model_validate_json(item.read_text(encoding="utf-8"))
        for criterion in checklist.criteria:
            by_meaning[meaning_fingerprint(criterion)] = tuple(criterion.team_notes)
            every_note.update(criterion.team_notes)
    return by_meaning, frozenset(every_note)


def effective_notes(criterion: Criterion) -> list[str]:
    """Team notes that still apply.

    Default notes follow the official meaning. When a criterion is reworded they
    are dropped even if an editor copied them along, while notes a person wrote
    for the new wording are kept and come last, so they can override. A note in
    `disabled_notes` is out either way: that is the only way to switch off a default.
    """
    by_meaning, every_note = _default_notes()
    inherited = list(by_meaning.get(meaning_fingerprint(criterion), ()))
    own = [note for note in criterion.team_notes if note not in every_note]
    disabled = set(criterion.disabled_notes)
    return [note for note in inherited + own if note not in disabled]


def allowed_answers(criterion: Criterion) -> list[str]:
    if criterion.type is CriterionType.SCALE:
        answers = [str(level.value) for level in criterion.levels]
    else:
        answers = ["yes", "no"]
    if criterion.allow_na:
        answers.append(NA_ANSWER)
    return answers


def render_criterion(criterion: Criterion, section_title: str) -> str:
    lines = [f"### {criterion.id}. {criterion.title}", f"Секция: {section_title}"]
    lines.append("Допустимые ответы: " + ", ".join(allowed_answers(criterion)))
    if criterion.flag:
        lines.append("Это флаг нарушения без баллов: yes означает, что нарушение есть.")
    if criterion.yes_when:
        lines.append(f"Условие yes: {criterion.yes_when}")
    if criterion.prompt:
        lines.append(f"Задача: {criterion.prompt}")
    if criterion.levels:
        lines.append("Шкала:")
        lines.extend(f"- {level.value}: {level.text}" for level in criterion.levels)
    if criterion.allow_na:
        lines.append(f"Условие na: {criterion.na_when}")
    else:
        lines.append("Ответ na запрещён.")
    notes = effective_notes(criterion)
    if notes:
        lines.append("Уточнения команды:")
        lines.extend(f"- {note}" for note in notes)
    return "\n".join(lines)


def render_rubric(checklist: ChecklistVersion) -> str:
    titles = {section.id: section.title for section in checklist.sections}
    blocks = [render_criterion(c, titles[c.section]) for c in checklist.criteria]
    if checklist.excluded_from_scoring:
        excluded = ", ".join(checklist.excluded_from_scoring)
        blocks.append(f"Вне оценки, не учитывай: {excluded}.")
    return "\n\n".join(blocks)


def response_schema(checklist: ChecklistVersion) -> dict[str, Any]:
    """A deliberately flat schema with no unions, so every provider can compile it.

    Which answers a given criterion allows is checked afterwards by the validator.
    """
    answers: list[str] = []
    for criterion in checklist.criteria:
        answers.extend(a for a in allowed_answers(criterion) if a not in answers)
    answers.append(UNASSESSABLE_ANSWER)
    evidence = {
        "type": "object",
        "properties": {"turn_index": {"type": "integer"}, "quote": {"type": "string"}},
        "required": ["turn_index", "quote"],
        "additionalProperties": False,
    }
    item = {
        "type": "object",
        "properties": {
            "criterion_id": {"type": "string", "enum": [c.id for c in checklist.criteria]},
            "analysis": {"type": "string"},
            "answer": {"type": "string", "enum": answers},
            "justification": {"type": "string"},
            "evidence": {"type": "array", "items": evidence},
            "reviewed_from_turn": {"type": "integer"},
            "reviewed_to_turn": {"type": "integer"},
            "expected_at_turn": {"type": "integer"},
            "review_flags": {"type": "array", "items": {"type": "string"}},
        },
        "required": [
            "criterion_id",
            "analysis",
            "answer",
            "justification",
            "evidence",
            "reviewed_from_turn",
            "reviewed_to_turn",
            "expected_at_turn",
            "review_flags",
        ],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {"results": {"type": "array", "items": item}},
        "required": ["results"],
        "additionalProperties": False,
    }
