"""Public entry points used by the backend. Their signatures are the contract.

`evaluate` is a stub at this point: it only knows the mock provider, so the
backend and the UI can be built before the real pipeline lands on `feat/ai`.
"""

from __future__ import annotations

import hashlib
import json
from importlib import resources
from typing import Any

from cqa_ai.contracts import (
    ChecklistVersion,
    ConversationSnapshot,
    CriterionResult,
    CriterionType,
    EvaluationOutput,
    EvaluatorConfig,
    Evidence,
    ModelAttempt,
    ResultStatus,
    ReviewStatus,
    Turn,
)

_KNOWN_RECORD_FIELDS = {"conversation_id", "channel", "language", "transcript", "audio_url"}


class EvaluatorNotConfigured(RuntimeError):
    """The requested provider cannot run, usually because a key is missing."""


def snapshot_from_record(record: dict[str, Any]) -> ConversationSnapshot:
    """Build a snapshot from one API record, keeping the transcript text untouched."""
    turns = [
        Turn(
            index=index,
            timestamp=str(turn.get("timestamp", "")),
            speaker=str(turn.get("speaker", "")),
            text=str(turn.get("text", "")),
        )
        for index, turn in enumerate(record["transcript"])
    ]
    return ConversationSnapshot(
        conversation_id=record["conversation_id"],
        channel=record["channel"],
        language=record["language"],
        turns=turns,
        audio_url=record.get("audio_url"),
        extra={k: v for k, v in record.items() if k not in _KNOWN_RECORD_FIELDS},
    )


def _digest(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def content_hash(snapshot: ConversationSnapshot) -> str:
    """Hash of everything meaningful in a dialogue. The signed audio URL is excluded."""
    return _digest(snapshot.model_dump(mode="json", exclude={"audio_url"}))


def checklist_hash(checklist: ChecklistVersion) -> str:
    """Hash of the rubric meaning. Weights are excluded: changing only a weight
    keeps the model answers valid and allows a deterministic recalculation."""
    payload = checklist.model_dump(mode="json", exclude={"version"})
    for criterion in payload["criteria"]:
        criterion.pop("weight", None)
    return _digest(payload)


def load_default_checklists() -> list[ChecklistVersion]:
    folder = resources.files("cqa_ai") / "checklists"
    return [
        ChecklistVersion.model_validate_json(item.read_text(encoding="utf-8"))
        for item in sorted(folder.iterdir(), key=lambda entry: entry.name)
        if item.name.endswith(".json")
    ]


def _mock_results(
    snapshot: ConversationSnapshot, checklist: ChecklistVersion
) -> list[CriterionResult]:
    first_operator = next((t for t in snapshot.turns if t.speaker == "operator"), None)
    evidence = (
        [Evidence(turn_index=first_operator.index, quote=first_operator.text)]
        if first_operator
        else []
    )
    results = []
    for criterion in checklist.criteria:
        if criterion.type is CriterionType.SCALE:
            answer: int | str = criterion.max_level
        else:
            answer = "no" if criterion.flag else "yes"
        results.append(
            CriterionResult(
                criterion_id=criterion.id,
                status=ResultStatus.ASSESSED,
                answer=answer,
                justification="Заглушка: реальная модель не вызывалась.",
                evidence=evidence,
                review_flags=["mock_provider"],
            )
        )
    return results


async def evaluate(
    snapshot: ConversationSnapshot,
    checklist: ChecklistVersion,
    config: EvaluatorConfig | None = None,
) -> EvaluationOutput:
    config = config or EvaluatorConfig()
    if config.provider != "mock":
        raise EvaluatorNotConfigured(f"provider {config.provider!r} is not available yet")
    return EvaluationOutput(
        results=_mock_results(snapshot, checklist),
        attempts=[ModelAttempt(provider="mock", model="mock", valid=True)],
        pipeline=config.pipeline,
        review_status=ReviewStatus.FLAGGED,
        review_reasons=["mock_provider"],
    )
