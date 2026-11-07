from conftest import model_reply

from cqa_ai.annotate import annotate
from cqa_ai.contracts import ResultStatus
from cqa_ai.validator import validate_response


def check(text, chat, checklist):
    return validate_response(text, chat, checklist, annotate(chat))


def by_id(report):
    return {result.criterion_id: result for result in report.results}


def test_a_clean_reply_passes(chat, checklist):
    report = check(model_reply(checklist), chat, checklist)
    assert not report.problems
    assert by_id(report)["c04"].answer == 20
    assert by_id(report)["c01"].answer == "yes"


def test_na_becomes_a_status_with_no_answer(chat, checklist):
    reply = model_reply(checklist, {"c03": {"answer": "na", "evidence": []}})
    result = by_id(check(reply, chat, checklist))["c03"]
    assert result.status is ResultStatus.NOT_APPLICABLE and result.answer is None


def test_code_fences_and_text_around_json_are_tolerated(chat, checklist):
    wrapped = f"Вот результат:\n```json\n{model_reply(checklist)}\n```\nГотово."
    assert not check(wrapped, chat, checklist).hard_errors


def test_garbage_fails_every_criterion_without_inventing_answers(chat, checklist):
    report = check("не json", chat, checklist)
    assert report.hard_errors
    assert {r.status for r in report.results} == {ResultStatus.FAILED}


def test_missing_criterion_is_failed_and_others_survive(chat, checklist):
    results = by_id(check(model_reply(checklist, drop={"c05"}), chat, checklist))
    assert results["c05"].status is ResultStatus.FAILED
    assert results["c01"].status is ResultStatus.ASSESSED


def test_na_where_the_rubric_forbids_it_is_rejected(chat, checklist):
    report = check(model_reply(checklist, {"c01": {"answer": "na"}}), chat, checklist)
    assert any("c01" in error for error in report.hard_errors)
    assert by_id(report)["c01"].status is ResultStatus.FAILED


def test_a_scale_value_between_levels_is_rejected(chat, checklist):
    report = check(model_reply(checklist, {"c04": {"answer": "12"}}), chat, checklist)
    assert any("c04" in error for error in report.hard_errors)


def test_duplicates_and_unknown_criteria_are_reported(chat, checklist):
    import json

    payload = json.loads(model_reply(checklist))
    payload["results"].append(payload["results"][0])
    payload["results"].append({**payload["results"][1], "criterion_id": "c99"})
    report = check(json.dumps(payload, ensure_ascii=False), chat, checklist)
    assert any("more than once" in error for error in report.hard_errors)
    assert any("c99" in error for error in report.hard_errors)


def test_a_made_up_quote_is_dropped_but_the_decision_stands(chat, checklist):
    reply = model_reply(
        checklist, {"c01": {"evidence": [{"turn_index": 4, "quote": "такого нет"}]}}
    )
    report = check(reply, chat, checklist)
    assert report.soft_errors and not report.hard_errors
    result = by_id(report)["c01"]
    assert result.answer == "yes" and result.evidence == []
    assert "evidence_missing" in result.review_flags


def flag_criterion(checklist):
    return next(criterion for criterion in checklist.criteria if criterion.flag)


def test_a_flag_answered_no_needs_no_quote(chat, checklist):
    # "No violation" has nothing to quote: the model read the whole dialogue.
    flag = flag_criterion(checklist)
    reply = model_reply(checklist, {flag.id: {"answer": "no", "evidence": []}})
    report = check(reply, chat, checklist)
    assert not report.problems
    result = by_id(report)[flag.id]
    assert result.evidence == [] and "evidence_missing" not in result.review_flags
    assert result.reviewed_range.from_turn == 0
    assert result.reviewed_range.to_turn == len(chat.turns) - 1


def test_a_flag_answered_no_keeps_the_range_the_model_gave(chat, checklist):
    flag = flag_criterion(checklist)
    reply = model_reply(
        checklist,
        {flag.id: {"answer": "no", "evidence": [], "reviewed_from_turn": 4, "reviewed_to_turn": 6}},
    )
    result = by_id(check(reply, chat, checklist))[flag.id]
    assert (result.reviewed_range.from_turn, result.reviewed_range.to_turn) == (4, 6)


def test_a_flag_answered_yes_still_needs_evidence(chat, checklist):
    flag = flag_criterion(checklist)
    reply = model_reply(checklist, {flag.id: {"answer": "yes", "evidence": []}})
    report = check(reply, chat, checklist)
    assert any(flag.id in problem for problem in report.soft_errors)
    assert "evidence_missing" in by_id(report)[flag.id].review_flags


def test_a_turn_that_does_not_exist_is_rejected(chat, checklist):
    reply = model_reply(checklist, {"c01": {"evidence": [{"turn_index": 99, "quote": "x"}]}})
    assert any("99" in error for error in check(reply, chat, checklist).soft_errors)


def test_whitespace_differences_resolve_to_the_exact_text(chat, checklist):
    reply = model_reply(
        checklist, {"c01": {"evidence": [{"turn_index": 4, "quote": "меня   зовут\nАнна"}]}}
    )
    report = check(reply, chat, checklist)
    assert by_id(report)["c01"].evidence[0].quote == "меня зовут Анна"


def test_a_missing_action_needs_no_quote_when_the_place_is_given(chat, checklist):
    reply = model_reply(
        checklist,
        {
            "c07": {
                "answer": "no",
                "evidence": [],
                "expected_at_turn": 6,
                "reviewed_from_turn": 4,
                "reviewed_to_turn": 6,
            }
        },
    )
    report = check(reply, chat, checklist)
    result = by_id(report)["c07"]
    assert not report.problems
    assert result.expected_at_turn == 6 and result.reviewed_range.to_turn == 6


def test_evidence_from_an_internal_turn_is_flagged(call):
    from cqa_ai import load_default_checklists

    voice = load_default_checklists()[1]
    reply = model_reply(voice, {"c01": {"evidence": [{"turn_index": 5, "quote": "Коллега"}]}})
    report = validate_response(reply, call, voice, annotate(call))
    assert "evidence_internal_turn" in by_id(report)["c01"].review_flags
