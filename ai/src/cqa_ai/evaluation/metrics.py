"""Comparison with the reference. Metrics stay separate on purpose: the organizers'
formula is unknown, so no invented overall rating hides a weak criterion."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from cqa_ai.contracts import ChecklistVersion, CriterionResult, ResultStatus
from cqa_ai.rubric import NA_ANSWER
from cqa_ai.scoring import ScoringError, calculate_score


def label_results(checklist: ChecklistVersion, label: dict[str, Any]) -> list[CriterionResult]:
    results = []
    for criterion in checklist.criteria:
        value = label[criterion.id]
        if value == NA_ANSWER:
            results.append(
                CriterionResult(criterion_id=criterion.id, status=ResultStatus.NOT_APPLICABLE)
            )
        else:
            results.append(
                CriterionResult(
                    criterion_id=criterion.id, status=ResultStatus.ASSESSED, answer=value
                )
            )
    return results


def _value(result: CriterionResult | None) -> Any:
    if result is None or result.status is ResultStatus.FAILED:
        return None
    if result.status is ResultStatus.NOT_APPLICABLE:
        return NA_ANSWER
    if result.status is ResultStatus.UNASSESSABLE:
        return "unassessable"
    return result.answer


@dataclass
class CriterionStats:
    compared: int = 0
    exact: int = 0
    false_na: int = 0
    false_applicable: int = 0
    mismatches: list[str] = field(default_factory=list)


@dataclass
class GroupStats:
    count: int = 0
    errors: list[float] = field(default_factory=list)

    @property
    def mae(self) -> float | None:
        return round(sum(self.errors) / len(self.errors), 2) if self.errors else None


@dataclass
class Report:
    labeled: int = 0
    scored: int = 0
    failed: list[str] = field(default_factory=list)
    errors: list[tuple[float, str]] = field(default_factory=list)
    criteria: dict[str, CriterionStats] = field(
        default_factory=lambda: defaultdict(CriterionStats)
    )
    groups: dict[str, GroupStats] = field(default_factory=lambda: defaultdict(GroupStats))
    gross_missed: list[str] = field(default_factory=list)
    gross_false: list[str] = field(default_factory=list)

    @property
    def mae(self) -> float | None:
        if not self.errors:
            return None
        return round(sum(error for error, _ in self.errors) / len(self.errors), 2)


def compare(
    runs: list[dict[str, Any]], labels: dict[str, dict[str, Any]], checklist: ChecklistVersion
) -> Report:
    report = Report()
    flag_ids = {c.id for c in checklist.criteria if c.flag}
    for run in runs:
        conversation_id = run["conversation_id"]
        label = labels.get(conversation_id)
        if label is None:
            continue
        report.labeled += 1
        results = [CriterionResult.model_validate(item) for item in run["results"]]
        by_id = {result.criterion_id: result for result in results}

        for criterion in checklist.criteria:
            expected = label[criterion.id]
            actual = _value(by_id.get(criterion.id))
            stats = report.criteria[criterion.id]
            if actual is None:
                continue
            stats.compared += 1
            if actual == expected:
                stats.exact += 1
                continue
            stats.mismatches.append(f"{conversation_id}: {expected} → {actual}")
            if actual == NA_ANSWER:
                stats.false_na += 1
            elif expected == NA_ANSWER:
                stats.false_applicable += 1
            if criterion.id in flag_ids:
                bucket = report.gross_missed if expected == "yes" else report.gross_false
                bucket.append(conversation_id)

        try:
            total = calculate_score(checklist, results).total
        except ScoringError:
            total = None
        if total is None:
            report.failed.append(conversation_id)
            continue
        reference = calculate_score(checklist, label_results(checklist, label)).total
        error = abs(total - reference)
        report.scored += 1
        report.errors.append((round(error, 2), conversation_id))
        for key in (f"язык {run['language']}", f"канал {run['channel']}"):
            report.groups[key].count += 1
            report.groups[key].errors.append(error)
    return report


def render(report: Report) -> str:
    lines = [
        f"Сравнено диалогов: {report.scored} из {report.labeled} размеченных",
        f"Без итога: {len(report.failed)} {report.failed if report.failed else ''}".rstrip(),
        f"MAE итога: {report.mae}",
    ]
    worst = sorted(report.errors, reverse=True)[:5]
    lines.append("Худшие: " + ", ".join(f"{cid} {error}" for error, cid in worst))
    lines.append("")
    lines.append("Критерий   совпало        ложное N/A  ложно применимо")
    for criterion_id in sorted(report.criteria):
        stats = report.criteria[criterion_id]
        share = round(100 * stats.exact / stats.compared) if stats.compared else 0
        lines.append(
            f"{criterion_id:<10} {stats.exact}/{stats.compared} ({share}%)".ljust(26)
            + f"{stats.false_na:<12}{stats.false_applicable}"
        )
    lines.append("")
    for key in sorted(report.groups):
        group = report.groups[key]
        lines.append(f"{key}: MAE {group.mae}, диалогов {group.count}")
    lines.append("")
    lines.append(f"Грубые ошибки пропущены: {report.gross_missed or 'нет'}")
    lines.append(f"Грубые ошибки ложные: {report.gross_false or 'нет'}")
    lines.append("")
    lines.append("Расхождения:")
    for criterion_id in sorted(report.criteria):
        for mismatch in report.criteria[criterion_id].mismatches:
            lines.append(f"  {criterion_id} {mismatch}")
    return "\n".join(lines)
