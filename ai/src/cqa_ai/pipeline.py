"""One evaluation: full transcript and rubric in, validated decisions out.

Limits are fixed in advance so behaviour during the control run cannot drift:
a small number of transport retries, one attempt to repair the contract, and one
switch to the fallback model. A failure stays visible as `failed` and is never
turned into a zero.
"""

from __future__ import annotations

import asyncio
import random
import time

from cqa_ai.annotate import ConversationFacts, annotate
from cqa_ai.contracts import (
    ChecklistVersion,
    ConversationSnapshot,
    CriterionResult,
    EvaluationOutput,
    EvaluatorConfig,
    ModelAttempt,
    ResultStatus,
    ReviewStatus,
)
from cqa_ai.prompt import Prompt, build_prompt
from cqa_ai.providers import (
    PermanentProviderError,
    Provider,
    ProviderResponse,
    TransientProviderError,
)
from cqa_ai.rubric import response_schema
from cqa_ai.validator import ValidationReport, validate_response

TRANSPORT_RETRIES = 2
CONTRACT_REPAIRS = 1
BASE_BACKOFF_SECONDS = 2.0
RATE_LIMIT_WAIT_SECONDS = 20.0
MAX_WAIT_SECONDS = 90.0


def _delay(retry: int, error: TransientProviderError) -> float:
    if error.retry_after is not None:
        return min(error.retry_after, MAX_WAIT_SECONDS)
    base = RATE_LIMIT_WAIT_SECONDS if "rate limit" in str(error) else BASE_BACKOFF_SECONDS
    wait = base * 2**retry
    return min(wait + random.uniform(0, wait / 2), MAX_WAIT_SECONDS)


async def _call(
    provider: Provider,
    prompt: Prompt,
    user: str,
    schema: dict,
    config: EvaluatorConfig,
    attempts: list[ModelAttempt],
    role: str,
) -> ProviderResponse:
    for retry in range(TRANSPORT_RETRIES + 1):
        attempt = ModelAttempt(
            provider=provider.name, model=config.model, role=role, attempt=len(attempts) + 1
        )
        attempts.append(attempt)
        started = time.monotonic()
        try:
            response = await provider.complete(
                system=prompt.system, user=user, schema=schema, config=config
            )
        except TransientProviderError as error:
            attempt.latency_ms = int((time.monotonic() - started) * 1000)
            attempt.errors.append(str(error))
            if retry == TRANSPORT_RETRIES:
                raise
            await asyncio.sleep(_delay(retry, error))
            continue
        except PermanentProviderError as error:
            attempt.latency_ms = int((time.monotonic() - started) * 1000)
            attempt.errors.append(str(error))
            raise
        attempt.latency_ms = int((time.monotonic() - started) * 1000)
        attempt.input_tokens = response.input_tokens
        attempt.output_tokens = response.output_tokens
        attempt.cost_usd = provider.cost_per_call
        return response
    raise AssertionError("unreachable")


def _repair_note(report: ValidationReport) -> str:
    listed = "\n".join(f"- {problem}" for problem in report.problems)
    return (
        "\n\nТвой предыдущий ответ нарушил контракт. Верни полный ответ заново, "
        f"исправив только это:\n{listed}"
    )


def _all_failed(checklist: ChecklistVersion, reason: str) -> list[CriterionResult]:
    return [
        CriterionResult(
            criterion_id=criterion.id,
            status=ResultStatus.FAILED,
            justification=reason,
            review_flags=["model_call_failed"],
        )
        for criterion in checklist.criteria
    ]


def _review(results: list[CriterionResult], extra: list[str]) -> tuple[ReviewStatus, list[str]]:
    reasons = list(extra)
    for result in results:
        reasons.extend(f"{result.criterion_id}:{flag}" for flag in result.review_flags)
    return (ReviewStatus.FLAGGED if reasons else ReviewStatus.CLEAR), reasons


async def _ask_model(
    snapshot: ConversationSnapshot,
    checklist: ChecklistVersion,
    facts: ConversationFacts,
    prompt: Prompt,
    config: EvaluatorConfig,
    provider: Provider,
    attempts: list[ModelAttempt],
    run_flags: list[str],
) -> ValidationReport | None:
    """The best report one model produced, or None if it never answered."""
    schema = response_schema(checklist)
    report: ValidationReport | None = None
    user = prompt.user
    for repair in range(CONTRACT_REPAIRS + 1):
        role = "primary" if repair == 0 else "repair"
        try:
            response = await _call(provider, prompt, user, schema, config, attempts, role)
        except (TransientProviderError, PermanentProviderError):
            if report is not None:
                run_flags.append("repair_failed")
            break
        if response.truncated:
            attempts[-1].errors.append("the response was truncated")
        current = validate_response(response.text, snapshot, checklist, facts)
        attempts[-1].valid = not current.hard_errors
        attempts[-1].errors.extend(current.problems)
        if report is None or len(current.hard_errors) <= len(report.hard_errors):
            report = current
        if not current.problems:
            break
        run_flags.append("contract_repair_used")
        user = prompt.user + _repair_note(current)
    return report


def _usable(report: ValidationReport | None) -> bool:
    return report is not None and any(
        result.status is not ResultStatus.FAILED for result in report.results
    )


async def run_single(
    snapshot: ConversationSnapshot,
    checklist: ChecklistVersion,
    config: EvaluatorConfig,
    provider: Provider,
) -> EvaluationOutput:
    facts = annotate(snapshot)
    prompt = build_prompt(snapshot, checklist, facts)
    attempts: list[ModelAttempt] = []
    run_flags: list[str] = []

    report = await _ask_model(
        snapshot, checklist, facts, prompt, config, provider, attempts, run_flags
    )
    if not _usable(report) and config.fallback_model:
        fallback = config.model_copy(update={"model": config.fallback_model})
        report = await _ask_model(
            snapshot, checklist, facts, prompt, fallback, provider, attempts, run_flags
        )
        if _usable(report):
            run_flags.append("served_by_fallback_model")

    if not _usable(report):
        last_error = next(
            (error for attempt in reversed(attempts) for error in reversed(attempt.errors)),
            "ответа нет",
        )
        return EvaluationOutput(
            results=_all_failed(checklist, f"Модель не дала ответа: {last_error}"),
            attempts=attempts,
            pipeline=config.pipeline,
            prompt_hash=prompt.prompt_hash,
            review_status=ReviewStatus.FLAGGED,
            review_reasons=["model_call_failed"],
        )

    assert report is not None
    if report.soft_errors:
        run_flags.append("evidence_partly_rejected")
    status, reasons = _review(report.results, sorted(set(run_flags)))
    return EvaluationOutput(
        results=report.results,
        attempts=attempts,
        pipeline=config.pipeline,
        prompt_hash=prompt.prompt_hash,
        review_status=status,
        review_reasons=reasons,
    )
