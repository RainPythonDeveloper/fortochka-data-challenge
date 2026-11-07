import asyncio

import pytest

from cqa_ai import (
    EvaluatorNotConfigured,
    calculate_score,
    checklist_hash,
    content_hash,
    evaluate,
    load_default_checklists,
    snapshot_from_record,
)
from cqa_ai.contracts import EvaluatorConfig

RECORD = {
    "conversation_id": "test-001",
    "channel": "agent chat",
    "language": "RU",
    "transcript": [
        {"timestamp": "00:00", "speaker": "client", "text": "Где тариф?"},
        {"timestamp": "00:00", "speaker": "operator", "text": "Здравствуйте, я Анна."},
    ],
    "audio_url": None,
    "new_field": 1,
}


def test_default_checklist_matches_the_official_weights():
    checklist = load_default_checklists()[0]
    assert len(checklist.criteria) == 8
    assert sum(c.weight for c in checklist.criteria) == 100
    assert [c.id for c in checklist.criteria if c.allow_na] == ["c02", "c03", "c04", "c07"]
    gross = next(c for c in checklist.criteria if c.id == "c08")
    assert gross.weight == 0 and not gross.scored and gross.flag == "gross_error"


def test_snapshot_keeps_order_duplicates_and_unknown_fields():
    snapshot = snapshot_from_record(RECORD)
    assert [t.index for t in snapshot.turns] == [0, 1]
    assert snapshot.extra == {"new_field": 1}


def test_content_hash_ignores_the_signed_audio_url():
    first = snapshot_from_record({**RECORD, "audio_url": "https://example.test/a?sig=1"})
    second = snapshot_from_record({**RECORD, "audio_url": "https://example.test/a?sig=2"})
    assert content_hash(first) == content_hash(second)


def test_checklist_hash_ignores_weight_but_not_meaning():
    checklist = load_default_checklists()[0]
    reweighted = checklist.model_copy(deep=True)
    reweighted.criteria[0].weight = 25
    rewritten = checklist.model_copy(deep=True)
    rewritten.criteria[0].yes_when = "Другой смысл."
    assert checklist_hash(checklist) == checklist_hash(reweighted)
    assert checklist_hash(checklist) != checklist_hash(rewritten)


def test_mock_evaluation_is_scored_and_marked_as_mock():
    checklist = load_default_checklists()[0]
    output = asyncio.run(evaluate(snapshot_from_record(RECORD), checklist))
    assert calculate_score(checklist, output.results).total == 100.00
    assert output.review_reasons == ["mock_provider"]


def test_unknown_provider_fails_loudly():
    checklist = load_default_checklists()[0]
    with pytest.raises(EvaluatorNotConfigured):
        asyncio.run(
            evaluate(
                snapshot_from_record(RECORD),
                checklist,
                EvaluatorConfig(provider="none", model="none"),
            )
        )
