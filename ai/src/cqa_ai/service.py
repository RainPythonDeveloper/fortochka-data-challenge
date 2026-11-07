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
from cqa_ai.strategies import STRATEGIES
from cqa_ai.providers import PROFILES, get_provider, missing_key, split_model

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

    # `LLM_MODEL=provider:model` selects the endpoint; a bare model keeps `provider`.
    default_provider = config.provider
    provider_name, model = split_model(config.model, config.provider)
    if (provider_name, model) != (config.provider, config.model):
        config = config.model_copy(update={"provider": provider_name, "model": model})
    provider = _provider_or_raise(config.provider)

    if config.fallback_model is None:
        config = config.model_copy(
            update={"fallback_model": os.environ.get("LLM_FALLBACK_MODEL") or None}
        )
    fallback_provider = None
    if config.fallback_model:
        # A bare fallback belongs to LLM_PROVIDER, not to the primary's prefix.
        fallback_name, fallback_model = split_model(config.fallback_model, default_provider)
        config = config.model_copy(update={"fallback_model": fallback_model})
        if fallback_name != config.provider:
            if missing_key(fallback_name) or fallback_name not in PROFILES:
                # Never send another provider's model id to the primary endpoint.
                config = config.model_copy(update={"fallback_model": ""})
            else:
                fallback_provider = get_provider(fallback_name)

    personal = snapshot.channel in _PERSONAL_DATA_CHANNELS
    if personal and not _may_send_personal_data(provider):
        # A provider that keeps data on this machine may take the call instead.
        if fallback_provider is not None and _may_send_personal_data(fallback_provider):
            config = config.model_copy(
                update={"provider": fallback_provider.name, "model": config.fallback_model}
            )
            return await run_single(snapshot, checklist, config, fallback_provider)
        return _blocked(checklist, config)
    if personal and fallback_provider is not None and not _may_send_personal_data(fallback_provider):
        fallback_provider = None
        config = config.model_copy(update={"fallback_model": ""})

    for field, variable in (("second_model", "LLM_SECOND_MODEL"), ("arbiter_model", "LLM_ARBITER_MODEL")):
        if getattr(config, field) is None:
            config = config.model_copy(update={field: os.environ.get(variable) or ""})

    def provider_for(spec: str) -> tuple[Any, str]:
        name, model_id = split_model(spec, config.provider)
        other = _provider_or_raise(name)
        if personal and not _may_send_personal_data(other):
            raise EvaluatorNotConfigured(f"{name} не принимает персональные данные")
        return other, model_id

    strategy = STRATEGIES.get(config.pipeline)
    if strategy is None:
        raise EvaluatorNotConfigured(f"неизвестная стратегия {config.pipeline!r}")
    if not config.second_criteria and os.environ.get("LLM_SECOND_CRITERIA"):
        ids = [x.strip() for x in os.environ["LLM_SECOND_CRITERIA"].split(",") if x.strip()]
        config = config.model_copy(update={"second_criteria": ids})
    if config.pipeline in ("two_judges", "second_opinion") and config.second_model:
        try:
            provider_for(config.second_model)
            provider_for(config.arbiter_model or f"{config.provider}:{config.model}")
        except EvaluatorNotConfigured:
            # A judge that may not see this conversation: fall back to one judge.
            strategy = STRATEGIES["single"]
    return await strategy(
        snapshot, checklist, config, provider, fallback_provider, provider_for=provider_for
    )


def _may_send_personal_data(provider: Any) -> bool:
    if getattr(provider, "allows_personal_data", False):
        return True
    return os.environ.get(_ALLOW_PERSONAL_DATA) == "1"


def _provider_or_raise(name: str) -> Any:
    variable = missing_key(name)
    if variable:
        raise EvaluatorNotConfigured(f"Оценщик не настроен: не задан {variable}")
    try:
        return get_provider(name)
    except ValueError as error:
        raise EvaluatorNotConfigured(str(error)) from error
