"""Checks a model response against the rubric and the snapshot it was given.

A hard problem makes a decision unusable and is worth one repair attempt. A soft
problem concerns only the evidence: the decision stands, the bad citation is
dropped and flagged, so a citation can never point at something that is not there.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from cqa_ai.annotate import ConversationFacts
from cqa_ai.contracts import (
    ChecklistVersion,
    ConversationSnapshot,
    Criterion,
    CriterionResult,
    CriterionType,
    Evidence,
    ResultStatus,
    TurnRange,
)
from cqa_ai.rubric import NA_ANSWER, UNASSESSABLE_ANSWER, allowed_answers

_SPACES = re.compile(r"\s+")


@dataclass
class ValidationReport:
    results: list[CriterionResult] = field(default_factory=list)
    hard_errors: list[str] = field(default_factory=list)
    soft_errors: list[str] = field(default_factory=list)

    @property
    def problems(self) -> list[str]:
        return self.hard_errors + self.soft_errors


def _load_json(text: str) -> Any:
    """Parse a model reply, tolerating a code fence or text around the object."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end <= start:
            raise
        return json.loads(text[start : end + 1])


def _failed(criterion_id: str, reason: str) -> CriterionResult:
    return CriterionResult(
        criterion_id=criterion_id,
        status=ResultStatus.FAILED,
        justification=reason,
        review_flags=["model_output_invalid"],
    )


def _decode(answer: str, criterion: Criterion) -> tuple[ResultStatus, str | int | None]:
    if answer == NA_ANSWER:
        return ResultStatus.NOT_APPLICABLE, None
    if answer == UNASSESSABLE_ANSWER:
        return ResultStatus.UNASSESSABLE, None
    if criterion.type is CriterionType.SCALE:
        return ResultStatus.ASSESSED, int(answer)
    return ResultStatus.ASSESSED, answer


def _match_quote(quote: str, text: str) -> str | None:
    """Return the exact substring for a quote, forgiving only whitespace differences."""
    if quote and quote in text:
        return quote
    pattern = r"\s+".join(re.escape(part) for part in _SPACES.split(quote.strip()) if part)
    if not pattern:
        return None
    found = re.search(pattern, text)
    return found.group(0) if found else None


def _check_evidence(
    raw: list[dict[str, Any]],
    criterion_id: str,
    snapshot: ConversationSnapshot,
    facts: ConversationFacts,
    report: ValidationReport,
    flags: list[str],
) -> list[Evidence]:
    turns = {turn.index: turn for turn in snapshot.turns}
    evidence: list[Evidence] = []
    for item in raw:
        index = item.get("turn_index")
        turn = turns.get(index) if isinstance(index, int) else None
        if turn is None:
            report.soft_errors.append(f"{criterion_id}: turn {index} does not exist")
            continue
        quote = _match_quote(str(item.get("quote", "")), turn.text)
        if quote is None:
            report.soft_errors.append(
                f"{criterion_id}: the quote is not an exact substring of turn {index}"
            )
            continue
        if facts.is_internal(index) and "evidence_internal_turn" not in flags:
            flags.append("evidence_internal_turn")
        evidence.append(Evidence(turn_index=index, quote=quote))
    return evidence


def _turn_or_none(value: Any, snapshot: ConversationSnapshot) -> int | None:
    if isinstance(value, int) and 0 <= value < len(snapshot.turns):
        return value
    return None


def validate_response(
    text: str,
    snapshot: ConversationSnapshot,
    checklist: ChecklistVersion,
    facts: ConversationFacts,
) -> ValidationReport:
    report = ValidationReport()
    try:
        payload = _load_json(text)
        items = payload["results"]
        if not isinstance(items, list):
            raise TypeError("results is not a list")
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        report.hard_errors.append(f"the response is not the required JSON: {error}")
        report.results = [_failed(c.id, "Ответ модели не разобран.") for c in checklist.criteria]
        return report

    by_id: dict[str, dict[str, Any]] = {}
    for item in items:
        criterion_id = item.get("criterion_id") if isinstance(item, dict) else None
        if criterion_id in by_id:
            report.hard_errors.append(f"{criterion_id}: returned more than once")
        elif criterion_id is not None:
            by_id[criterion_id] = item

    known = {criterion.id for criterion in checklist.criteria}
    for unknown in sorted(set(by_id) - known):
        report.hard_errors.append(f"{unknown}: is not in the rubric")

    for criterion in checklist.criteria:
        item = by_id.get(criterion.id)
        if item is None:
            report.hard_errors.append(f"{criterion.id}: missing from the response")
            report.results.append(_failed(criterion.id, "Модель не вернула этот критерий."))
            continue

        answer = str(item.get("answer", ""))
        if answer not in allowed_answers(criterion) + [UNASSESSABLE_ANSWER]:
            report.hard_errors.append(f"{criterion.id}: answer {answer!r} is not allowed")
            report.results.append(_failed(criterion.id, f"Недопустимый ответ: {answer}."))
            continue

        status, value = _decode(answer, criterion)
        justification = str(item.get("justification", "")).strip()
        flags = [str(flag) for flag in item.get("review_flags", []) if str(flag).strip()]
        evidence = _check_evidence(
            item.get("evidence") or [], criterion.id, snapshot, facts, report, flags
        )
        reviewed_from = _turn_or_none(item.get("reviewed_from_turn"), snapshot)
        reviewed_to = _turn_or_none(item.get("reviewed_to_turn"), snapshot)
        reviewed = (
            TurnRange(from_turn=reviewed_from, to_turn=reviewed_to)
            if reviewed_from is not None and reviewed_to is not None
            else None
        )
        expected = _turn_or_none(item.get("expected_at_turn"), snapshot)

        if not justification:
            report.soft_errors.append(f"{criterion.id}: the justification is empty")
        if status is ResultStatus.ASSESSED and not evidence and reviewed is None and expected is None:
            report.soft_errors.append(
                f"{criterion.id}: give evidence, or the place where the action was expected"
            )
            flags.append("evidence_missing")

        report.results.append(
            CriterionResult(
                criterion_id=criterion.id,
                status=status,
                answer=value,
                justification=justification,
                evidence=evidence,
                reviewed_range=reviewed,
                expected_at_turn=expected,
                review_flags=flags,
            )
        )
    return report
