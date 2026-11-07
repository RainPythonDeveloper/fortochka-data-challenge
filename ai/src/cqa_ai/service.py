"""Public entry points used by the backend. Their signatures are the contract."""

from __future__ import annotations

import hashlib
import json
import os
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
from cqa_ai.pipeline import run_single
from cqa_ai.providers import get_provider, missing_key

_KNOWN_RECORD_FIELDS = {"conversation_id", "channel", "language", "transcript", "audio_url"}
# Real calls hold personal data, and NVIDIA's free endpoints record their input and
# ask not to send personal data. Sending a call is therefore an explicit decision.
_PERSONAL_DATA_CHANNELS = {"voice call"}
_ALLOW_PERSONAL_DATA = "CQA_ALLOW_VOICE_TO_CLOUD"


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
        # Empty means nothing is switched off: versions saved before the field keep their hash.
        if not criterion.get("disabled_notes"):
            criterion.pop("disabled_notes", None)
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


def _blocked(checklist: ChecklistVersion, config: EvaluatorConfig) -> EvaluationOutput:
    reason = (
        "Звонок не отправлен в модель: в нём есть персональные данные, а бесплатный API "
        f"записывает запросы. Разрешить отправку можно настройкой {_ALLOW_PERSONAL_DATA}=1."
    )
    return EvaluationOutput(
        results=[
            CriterionResult(
                criterion_id=criterion.id,
                status=ResultStatus.FAILED,
                justification=reason,
                review_flags=["personal_data_not_sent"],
            )
            for criterion in checklist.criteria
        ],
        pipeline=config.pipeline,
        review_status=ReviewStatus.FLAGGED,
        review_reasons=["personal_data_not_sent"],
    )


async def evaluate(
    snapshot: ConversationSnapshot,
    checklist: ChecklistVersion,
    config: EvaluatorConfig | None = None,
) -> EvaluationOutput:
    config = config or EvaluatorConfig()
    if config.provider == "mock":
        return EvaluationOutput(
            results=_mock_results(snapshot, checklist),
            attempts=[ModelAttempt(provider="mock", model="mock", valid=True)],
            pipeline=config.pipeline,
            review_status=ReviewStatus.FLAGGED,
            review_reasons=["mock_provider"],
        )

    variable = missing_key(config.provider)
    if variable:
        raise EvaluatorNotConfigured(f"Оценщик не настроен: не задан {variable}")
    try:
        provider = get_provider(config.provider)
    except ValueError as error:
        raise EvaluatorNotConfigured(str(error)) from error

    if snapshot.channel in _PERSONAL_DATA_CHANNELS and os.environ.get(_ALLOW_PERSONAL_DATA) != "1":
        return _blocked(checklist, config)
    if config.fallback_model is None:
        config = config.model_copy(
            update={"fallback_model": os.environ.get("LLM_FALLBACK_MODEL") or None}
        )
    return await run_single(snapshot, checklist, config, provider)
