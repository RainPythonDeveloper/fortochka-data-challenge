"""Deterministic score calculation. No model is involved here.

Follows the "Порядок расчёта" block of the official checklist: a yes gives the
full weight, a no gives zero, a scale is proportional to its top level, N/A
weights are redistributed, the total is rounded to two decimals, and gross
errors are reported separately without touching the score.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

from cqa_ai.contracts import (
    ChecklistVersion,
    Criterion,
    CriterionResult,
    CriterionScore,
    CriterionType,
    ResultStatus,
    ScoreSummary,
    SectionScore,
)

_CENT = Decimal("0.01")
_HUNDRED = Decimal(100)


class ScoringError(ValueError):
    """A result breaks the checklist contract, so it must not be scored."""


def _round(value: Decimal) -> float:
    return float(value.quantize(_CENT, rounding=ROUND_HALF_UP))


def _fraction(criterion: Criterion, result: CriterionResult) -> Decimal:
    answer = result.answer
    if criterion.type is CriterionType.BOOLEAN:
        if answer == "yes":
            return Decimal(1)
        if answer == "no":
            return Decimal(0)
        raise ScoringError(f"{criterion.id}: expected yes or no, got {answer!r}")
    levels = {level.value for level in criterion.levels}
    if isinstance(answer, bool) or not isinstance(answer, int) or answer not in levels:
        raise ScoringError(f"{criterion.id}: {answer!r} is not a scale level")
    return Decimal(answer) / Decimal(criterion.max_level)


def _check_na(criterion: Criterion) -> None:
    if not criterion.allow_na:
        raise ScoringError(f"{criterion.id}: N/A is not allowed for this criterion")


def calculate_score(
    checklist: ChecklistVersion, results: list[CriterionResult]
) -> ScoreSummary:
    by_id = {result.criterion_id: result for result in results}
    unknown = set(by_id) - {criterion.id for criterion in checklist.criteria}
    if unknown:
        raise ScoringError(f"results for unknown criteria: {sorted(unknown)}")

    applicable_weight = Decimal(0)
    earned = Decimal(0)
    missing: list[str] = []
    gross: list[str] = []
    fractions: dict[str, Decimal] = {}

    for criterion in checklist.criteria:
        result = by_id.get(criterion.id)
        status = result.status if result else ResultStatus.FAILED
        weight = Decimal(str(criterion.weight)) if criterion.scored else Decimal(0)

        if status is ResultStatus.NOT_APPLICABLE:
            _check_na(criterion)
            continue
        if status is not ResultStatus.ASSESSED or result is None:
            if weight > 0:
                applicable_weight += weight
                missing.append(criterion.id)
            continue

        fraction = _fraction(criterion, result)
        if criterion.flag and result.answer == "yes":
            gross.append(criterion.id)
        if weight > 0:
            fractions[criterion.id] = fraction
            applicable_weight += weight
            earned += weight * fraction

    criteria_scores: list[CriterionScore] = []
    for criterion in checklist.criteria:
        result = by_id.get(criterion.id)
        weight = Decimal(str(criterion.weight)) if criterion.scored else Decimal(0)
        included = criterion.id in fractions or criterion.id in missing
        effective = (
            weight * _HUNDRED / applicable_weight
            if included and applicable_weight > 0
            else None
        )
        points = (
            effective * fractions[criterion.id]
            if effective is not None and criterion.id in fractions
            else None
        )
        criteria_scores.append(
            CriterionScore(
                criterion_id=criterion.id,
                status=result.status if result else ResultStatus.FAILED,
                answer=result.answer if result else None,
                weight=criterion.weight,
                effective_weight=_round(effective) if effective is not None else None,
                points=_round(points) if points is not None else None,
            )
        )

    sections: list[SectionScore] = []
    for section in checklist.sections:
        members = [c for c in checklist.criteria if c.section == section.id]
        section_earned = Decimal(0)
        section_possible = Decimal(0)
        for criterion in members:
            if criterion.id not in fractions and criterion.id not in missing:
                continue
            effective = Decimal(str(criterion.weight)) * _HUNDRED / applicable_weight
            section_possible += effective
            section_earned += effective * fractions.get(criterion.id, Decimal(0))
        sections.append(
            SectionScore(
                section_id=section.id,
                title=section.title,
                earned=_round(section_earned),
                possible=_round(section_possible),
                percent=(
                    _round(section_earned * _HUNDRED / section_possible)
                    if section_possible > 0
                    else None
                ),
                flags=[c.flag for c in members if c.id in gross and c.flag],
            )
        )

    ratio = _HUNDRED * earned / applicable_weight if applicable_weight > 0 else None
    return ScoreSummary(
        total=_round(ratio) if ratio is not None and not missing else None,
        partial_total=_round(ratio) if ratio is not None and missing else None,
        is_partial=bool(missing),
        missing_criteria=missing,
        gross_error=bool(gross),
        gross_error_criteria=gross,
        criteria=criteria_scores,
        sections=sections,
    )
