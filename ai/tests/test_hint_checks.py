"""A code fact contradicting the model raises a review flag, never changes the answer."""

from __future__ import annotations

import asyncio

from conftest import model_reply

from cqa_ai import snapshot_from_record
from cqa_ai.confidence import LOW_CONFIDENCE_FLAG
from cqa_ai.contracts import EvaluatorConfig
from cqa_ai.hint_checks import HINT_CONFLICT_FLAG
from cqa_ai.pipeline import run_single
from cqa_ai.providers import ProviderResponse


def chat_with_private_offer():
    turns = [
        ("client", "Как найти облигацию?"),
        ("bot", "Здравствуйте! Я бот."),
        ("system", "Эскалация на оператора."),
        ("client", "Нужна помощь."),
        ("operator", "Здравствуйте, меня зовут Анна. Откройте «Котировки»."),
        ("client", "Нашла."),
        ("operator", "Оставьте ваш личный номер, после работы позвоню и подберу бумаги за плату."),
    ]
    return snapshot_from_record(
        {
            "conversation_id": "synthetic-offer",
            "channel": "agent chat",
            "language": "RU",
            "transcript": [{"timestamp": "00:01", "speaker": s, "text": t} for s, t in turns],
            "audio_url": None,
        }
    )


class Reply:
    name = "fake"
    cost_per_call = 0.0

    def __init__(self, text):
        self.text = text

    async def complete(self, *, system, user, schema, config):
        return ProviderResponse(text=self.text, model=config.model)


def run(snapshot, checklist, overrides=None):
    reply = model_reply(checklist, overrides or {})
    return asyncio.run(
        run_single(snapshot, checklist, EvaluatorConfig(provider="fake", model="m"), Reply(reply))
    )


def c08(output):
    return next(r for r in output.results if r.criterion_id == "c08")


def test_missed_private_offer_is_flagged_for_review_but_answer_kept(checklist):
    output = run(chat_with_private_offer(), checklist)  # model_reply answers c08 "no"
    result = c08(output)
    assert result.answer == "no"
    assert HINT_CONFLICT_FLAG in result.review_flags
    assert LOW_CONFIDENCE_FLAG in result.review_flags
    assert result.confidence < 0.67


def test_no_flag_when_model_agrees_with_the_fact(checklist):
    output = run(chat_with_private_offer(), checklist, {"c08": {"answer": "yes"}})
    assert HINT_CONFLICT_FLAG not in c08(output).review_flags


def test_no_flag_without_the_fact(chat, checklist):
    output = run(chat, checklist)
    assert HINT_CONFLICT_FLAG not in c08(output).review_flags


def test_a_replaced_violation_criterion_is_not_second_guessed(checklist):
    edited = checklist.model_copy(deep=True)
    flag = next(c for c in edited.criteria if c.flag)
    flag.yes_when = "оператор использовал нецензурную лексику"
    output = run(chat_with_private_offer(), edited)
    assert HINT_CONFLICT_FLAG not in c08(output).review_flags
