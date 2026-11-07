import json
from importlib import resources
from pathlib import Path

from cqa_ai.contracts import CriterionResult, ResultStatus
from cqa_ai.evaluation.metrics import compare, render

MANIFEST = json.loads(
    (resources.files("cqa_ai") / "evaluation" / "manifest.json").read_text(encoding="utf-8")
)
LABELS = json.loads(
    (Path(__file__).parent.parent / "labels" / "reference_v1.json").read_text(encoding="utf-8")
)
ANSWERS = {"c01": "yes", "c02": "na", "c03": "na", "c04": 20, "c05": "yes", "c06": 10, "c07": "yes", "c08": "no"}


def result(criterion_id, value):
    if value == "na":
        return CriterionResult(criterion_id=criterion_id, status=ResultStatus.NOT_APPLICABLE)
    return CriterionResult(criterion_id=criterion_id, status=ResultStatus.ASSESSED, answer=value)


def run_row(conversation_id, answers, language="RU"):
    return {
        "conversation_id": conversation_id,
        "language": language,
        "channel": "agent chat",
        "results": [result(k, v).model_dump(mode="json") for k, v in answers.items()],
    }


def count(ids, prefix):
    return sum(1 for item in ids if item.startswith(prefix))


def test_split_matches_the_planned_quotas_without_overlap():
    splits = MANIFEST["splits"]
    quotas = {"tune": (14, 7, 7, 2), "compare": (8, 5, 5, 2), "holdout": (8, 3, 3, 1)}
    for name, (ru, kz, en, calls) in quotas.items():
        ids = splits[name]
        assert (count(ids, "p1-ru"), count(ids, "p1-kz"), count(ids, "p1-en"), count(ids, "p4-")) == (ru, kz, en, calls)
    every = [item for ids in splits.values() for item in ids]
    assert len(every) == len(set(every)) == 65


def test_scenario_families_stay_inside_one_split():
    families = [
        ["p1-ru-009", "p1-kz-015", "p1-en-014"],
        ["p1-ru-022", "p1-ru-023", "p1-kz-013", "p1-en-013"],
        ["p1-ru-012", "p1-kz-014", "p1-en-011"],
        ["p1-ru-004", "p1-ru-005", "p1-ru-026", "p1-kz-002", "p1-en-005"],
    ]
    for family in families:
        homes = {name for name, ids in MANIFEST["splits"].items() for item in family if item in ids}
        assert len(homes) == 1, family


def test_labels_cover_only_the_tuning_chats_and_are_marked_as_a_draft():
    assert LABELS["status"].startswith("draft")
    tune_chats = {cid for cid in MANIFEST["splits"]["tune"] if cid.startswith("p1-")}
    assert set(LABELS["labels"]) == tune_chats


def test_labels_are_valid_for_the_checklist(checklist):
    from cqa_ai import calculate_score
    from cqa_ai.evaluation.metrics import label_results

    for label in LABELS["labels"].values():
        assert calculate_score(checklist, label_results(checklist, label)).total is not None


def test_perfect_agreement(checklist):
    report = compare([run_row("x", ANSWERS)], {"x": ANSWERS}, checklist)
    assert report.mae == 0 and report.scored == 1
    assert report.criteria["c01"].exact == 1


def test_errors_and_na_mistakes_are_counted_separately(checklist):
    predicted = {**ANSWERS, "c04": 10, "c07": "na", "c02": "yes"}
    report = compare([run_row("x", predicted)], {"x": ANSWERS}, checklist)
    assert report.criteria["c04"].exact == 0
    assert report.criteria["c07"].false_na == 1
    assert report.criteria["c02"].false_applicable == 1
    assert report.mae > 0
    assert "c04 x: 20 → 10" in render(report)


def test_gross_errors_are_tracked_in_both_directions(checklist):
    missed = compare([run_row("x", ANSWERS)], {"x": {**ANSWERS, "c08": "yes"}}, checklist)
    false = compare([run_row("x", {**ANSWERS, "c08": "yes"})], {"x": ANSWERS}, checklist)
    assert missed.gross_missed == ["x"] and false.gross_false == ["x"]


def test_a_failed_criterion_stays_in_the_report(checklist):
    row = run_row("x", ANSWERS)
    row["results"][3] = CriterionResult(
        criterion_id="c04", status=ResultStatus.FAILED
    ).model_dump(mode="json")
    report = compare([row], {"x": ANSWERS}, checklist)
    assert report.failed == ["x"] and report.scored == 0


def test_groups_always_carry_their_size(checklist):
    rows = [run_row("a", ANSWERS, "KZ"), run_row("b", ANSWERS, "KZ"), run_row("c", ANSWERS, "EN")]
    report = compare(rows, {"a": ANSWERS, "b": ANSWERS, "c": ANSWERS}, checklist)
    assert report.groups["язык KZ"].count == 2
    assert "диалогов 2" in render(report)
