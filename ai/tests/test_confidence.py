"""W7: confidence is computed by code and only flags, never changes, an answer."""

from __future__ import annotations

import asyncio

from conftest import model_reply

from cqa_ai.confidence import LOW_CONFIDENCE_FLAG, assign_confidence
from cqa_ai.contracts import CriterionResult, EvaluatorConfig, JudgeVote, ResultStatus
from cqa_ai.pipeline import run_single
from cqa_ai.providers import ProviderResponse


def result(answer="yes", flags=None, votes=None):
    return CriterionResult(
        criterion_id="c01",
        status=ResultStatus.ASSESSED,
        answer=answer,
        review_flags=list(flags or []),
        votes=votes,
    )


def test_clean_single_judge_is_fully_confident():
    r = result()
    assign_confidence([r], [])
    assert r.confidence == 1.0 and LOW_CONFIDENCE_FLAG not in r.review_flags


def test_model_doubt_plus_repair_becomes_low_confidence_but_keeps_the_answer():
    r = result(answer="no", flags=["debatable_farewell"])
    assign_confidence([r], ["contract_repair_used"])
    assert r.confidence == 0.6
    assert r.answer == "no"
    assert LOW_CONFIDENCE_FLAG in r.review_flags


def test_votes_give_the_share_of_agreeing_judges():
    votes = [
        JudgeVote(model="a", status=ResultStatus.ASSESSED, answer="yes"),
        JudgeVote(model="b", status=ResultStatus.ASSESSED, answer="no"),
        JudgeVote(model="c", status=ResultStatus.ASSESSED, answer="yes"),
    ]
    r = result(answer="yes", votes=votes)
    assign_confidence([r], [])
    assert r.confidence == 0.67 and LOW_CONFIDENCE_FLAG not in r.review_flags


def test_failed_criterion_has_zero_confidence():
    r = CriterionResult(criterion_id="c01", status=ResultStatus.FAILED)
    assign_confidence([r], [])
    assert r.confidence == 0.0


class OneReply:
    name = "fake"
    cost_per_call = 0.0

    def __init__(self, text):
        self.text = text

    async def complete(self, *, system, user, schema, config):
        return ProviderResponse(text=self.text, model=config.model)


def test_pipeline_keeps_trace_fields(chat, checklist):
    reply = model_reply(
        checklist,
        {"c06": {"answer": "7", "rule_ref": "level:7", "higher_level_blocker": "клиент переспросил"}},
    )
    output = asyncio.run(
        run_single(chat, checklist, EvaluatorConfig(provider="fake", model="m"), OneReply(reply))
    )
    c06 = next(r for r in output.results if r.criterion_id == "c06")
    assert c06.rule_ref == "level:7"
    assert c06.alternative == "клиент переспросил"
    assert c06.analysis == "Коротко."
    assert all(r.confidence is not None for r in output.results)
