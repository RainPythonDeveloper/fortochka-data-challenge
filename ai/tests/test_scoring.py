"""The vectors come from AGENTS.md, section 7."""

import pytest

from cqa_ai import ScoringError, calculate_score, load_default_checklists
from cqa_ai.contracts import ChecklistVersion, CriterionResult, ResultStatus

CHECKLIST = load_default_checklists()[0]


def build(**answers) -> list[CriterionResult]:
    results = []
    for criterion_id, value in answers.items():
        if value == "na":
            results.append(
                CriterionResult(criterion_id=criterion_id, status=ResultStatus.NOT_APPLICABLE)
            )
        else:
            results.append(
                CriterionResult(
                    criterion_id=criterion_id, status=ResultStatus.ASSESSED, answer=value
                )
            )
    return results


def vector(c01, c02, c03, c04, c05, c06, c07, c08="no"):
    return build(c01=c01, c02=c02, c03=c03, c04=c04, c05=c05, c06=c06, c07=c07, c08=c08)


@pytest.mark.parametrize(
    ("answers", "total"),
    [
        (("yes", "yes", "yes", 20, "yes", 10, "yes"), 100.00),
        (("yes", "na", "na", 20, "yes", 10, "yes"), 100.00),
        (("yes", "na", "na", 15, "yes", 7, "no"), 77.69),
        (("yes", "yes", "na", "na", "yes", 10, "na"), 100.00),
        (("yes", "na", "na", 20, "yes", 10, "no"), 92.31),
        (("yes", "yes", "no", 10, "no", 7, "yes"), 50.50),
        (("no", "no", "no", 0, "no", 0, "no"), 0.00),
        (("yes", "no", "na", 5, "yes", 4, "no"), 45.00),
    ],
)
def test_official_vectors(answers, total):
    assert calculate_score(CHECKLIST, vector(*answers)).total == total


def test_gross_error_is_flagged_without_touching_the_score():
    clean = calculate_score(CHECKLIST, vector("yes", "na", "na", 20, "yes", 10, "yes"))
    gross = calculate_score(CHECKLIST, vector("yes", "na", "na", 20, "yes", 10, "yes", "yes"))
    assert gross.total == clean.total == 100.00
    assert gross.gross_error and gross.gross_error_criteria == ["c08"]
    assert not clean.gross_error


def test_effective_weights_are_redistributed():
    score = calculate_score(CHECKLIST, vector("yes", "na", "na", 20, "yes", 10, "yes"))
    effective = {c.criterion_id: c.effective_weight for c in score.criteria}
    assert effective["c02"] is None
    assert effective["c01"] == pytest.approx(15.38)
    assert effective["c08"] is None


def test_no_applicable_weight_gives_no_total():
    only_flag = CHECKLIST.model_copy(
        update={"criteria": [c for c in CHECKLIST.criteria if c.id == "c08"]}
    )
    checklist = ChecklistVersion.model_validate(only_flag.model_dump())
    assert calculate_score(checklist, build(c08="no")).total is None


def test_failed_criterion_is_not_a_zero_and_not_na():
    results = vector("yes", "na", "na", 20, "yes", 10, "yes")
    results[3] = CriterionResult(criterion_id="c04", status=ResultStatus.FAILED)
    score = calculate_score(CHECKLIST, results)
    assert score.total is None
    assert score.is_partial and score.missing_criteria == ["c04"]
    assert score.partial_total == pytest.approx(69.23)


def test_nothing_assessed_gives_no_partial_total_that_looks_like_zero():
    results = [
        CriterionResult(criterion_id=c.id, status=ResultStatus.FAILED) for c in CHECKLIST.criteria
    ]
    score = calculate_score(CHECKLIST, results)
    assert score.total is None and score.partial_total is None and score.is_partial


def test_missing_result_counts_as_failed():
    results = [r for r in vector("yes", "na", "na", 20, "yes", 10, "yes") if r.criterion_id != "c06"]
    assert calculate_score(CHECKLIST, results).missing_criteria == ["c06"]


@pytest.mark.parametrize(
    "results",
    [
        vector("yes", "na", "na", 12, "yes", 10, "yes"),
        vector("yes", "na", "na", "yes", "yes", 10, "yes"),
        vector(5, "na", "na", 20, "yes", 10, "yes"),
        vector("na", "na", "na", 20, "yes", 10, "yes"),
    ],
)
def test_contract_violations_are_rejected(results):
    with pytest.raises(ScoringError):
        calculate_score(CHECKLIST, results)


def test_unknown_answer_is_rejected_by_the_contract():
    with pytest.raises(ValueError):
        CriterionResult(criterion_id="c01", status=ResultStatus.ASSESSED, answer="maybe")


def test_sections_add_up_to_the_total():
    score = calculate_score(CHECKLIST, vector("yes", "yes", "no", 10, "no", 7, "yes"))
    assert sum(section.earned for section in score.sections) == pytest.approx(50.5)
    assert score.sections[-1].possible == 0 and score.sections[-1].percent is None
