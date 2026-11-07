"""Pipeline variants (W4) and judge ensembles (W5), chosen by `EvaluatorConfig.pipeline`.

Every strategy has the same signature as `run_single` and returns one
`EvaluationOutput` that passed the common validator. The checklist decides the
split: sections and criteria are read from it, so a swapped criterion is picked
up without code changes.

- single: one call for all criteria.
- sections: one call per checklist section, in parallel, merged.
- per_criterion: one call per criterion, in parallel, merged.
- two_judges: two different models judge independently; agreement is final,
  disagreements go to an arbiter that sees both judges' reasoning.
- vote: N runs of one model at a small temperature; majority per criterion,
  median level for scales.
"""

from __future__ import annotations

import asyncio
import statistics
from collections import Counter
from collections.abc import Awaitable, Callable

from cqa_ai.confidence import assign_confidence, vote_confidence
from cqa_ai.contracts import (
    ChecklistVersion,
    ConversationSnapshot,
    CriterionResult,
    EvaluationOutput,
    EvaluatorConfig,
    JudgeVote,
    ResultStatus,
    ReviewStatus,
)
from cqa_ai.pipeline import _review, run_single
from cqa_ai.providers import Provider

ProviderFor = Callable[[str], tuple[Provider, str]]
Strategy = Callable[..., Awaitable[EvaluationOutput]]


def subchecklist(checklist: ChecklistVersion, criterion_ids: list[str]) -> ChecklistVersion:
    keep = [c for c in checklist.criteria if c.id in criterion_ids]
    sections = {c.section for c in keep}
    return checklist.model_copy(
        update={
            "criteria": keep,
            "sections": [s for s in checklist.sections if s.id in sections],
        }
    )


def _merge(
    checklist: ChecklistVersion, outputs: list[EvaluationOutput], pipeline: str
) -> EvaluationOutput:
    by_id = {r.criterion_id: r for o in outputs for r in o.results}
    results = [by_id[c.id] for c in checklist.criteria if c.id in by_id]
    reasons = sorted({reason for o in outputs for reason in o.review_reasons})
    flagged = any(o.review_status is ReviewStatus.FLAGGED for o in outputs)
    return EvaluationOutput(
        results=results,
        attempts=[a for o in outputs for a in o.attempts],
        pipeline=pipeline,
        prompt_hash=outputs[0].prompt_hash if outputs else "",
        review_status=ReviewStatus.FLAGGED if flagged else ReviewStatus.CLEAR,
        review_reasons=reasons,
    )


async def run_split(
    snapshot: ConversationSnapshot,
    checklist: ChecklistVersion,
    config: EvaluatorConfig,
    provider: Provider,
    fallback_provider: Provider | None,
    groups: list[list[str]],
) -> EvaluationOutput:
    outputs = await asyncio.gather(
        *(
            run_single(snapshot, subchecklist(checklist, ids), config, provider, fallback_provider)
            for ids in groups
            if ids
        )
    )
    return _merge(checklist, list(outputs), config.pipeline)


async def run_sections(snapshot, checklist, config, provider, fallback_provider=None, **_):
    groups = [[c.id for c in checklist.criteria if c.section == s.id] for s in checklist.sections]
    return await run_split(snapshot, checklist, config, provider, fallback_provider, groups)


async def run_per_criterion(snapshot, checklist, config, provider, fallback_provider=None, **_):
    groups = [[c.id] for c in checklist.criteria]
    return await run_split(snapshot, checklist, config, provider, fallback_provider, groups)


def _vote(model: str, result: CriterionResult) -> JudgeVote:
    return JudgeVote(
        model=model,
        status=result.status,
        answer=result.answer,
        justification=result.justification,
    )


def _same(a: CriterionResult, b: CriterionResult) -> bool:
    return a.status == b.status and a.answer == b.answer


def _usable(output: EvaluationOutput) -> bool:
    return any(r.status is not ResultStatus.FAILED for r in output.results)


def _arbiter_note(conflicts: list[tuple[CriterionResult, CriterionResult]], a: str, b: str) -> str:
    lines = [
        "\n\nДва независимых судьи разошлись в этих критериях. Перечитай диалог и правило "
        "критерия и выбери ответ сам. Не усредняй и не выбирай по большинству: решает правило.",
    ]
    for ra, rb in conflicts:
        def show(r: CriterionResult) -> str:
            value = "na" if r.status is ResultStatus.NOT_APPLICABLE else r.answer
            return f"{value} — {r.justification or r.analysis or ''}".strip()

        lines.append(f"- {ra.criterion_id}: судья 1 ({a}): {show(ra)}; судья 2 ({b}): {show(rb)}")
    return "\n".join(lines)


async def run_two_judges(
    snapshot: ConversationSnapshot,
    checklist: ChecklistVersion,
    config: EvaluatorConfig,
    provider: Provider,
    fallback_provider: Provider | None = None,
    provider_for: ProviderFor | None = None,
) -> EvaluationOutput:
    if not config.second_model or provider_for is None:
        return await run_single(snapshot, checklist, config, provider, fallback_provider)
    second_provider, second_model = provider_for(config.second_model)
    second_config = config.model_copy(update={"model": second_model, "fallback_model": ""})
    first, second = await asyncio.gather(
        run_single(snapshot, checklist, config, provider, fallback_provider),
        run_single(snapshot, checklist, second_config, second_provider),
    )
    if not _usable(second):
        first.review_reasons = sorted(set(first.review_reasons) | {"second_judge_unavailable"})
        return first
    if not _usable(first):
        second.review_reasons = sorted(set(second.review_reasons) | {"first_judge_unavailable"})
        second.attempts = first.attempts + second.attempts
        return second

    a_by = {r.criterion_id: r for r in first.results}
    b_by = {r.criterion_id: r for r in second.results}
    conflicts = [
        (a_by[c.id], b_by[c.id])
        for c in checklist.criteria
        if c.id in a_by and c.id in b_by and not _same(a_by[c.id], b_by[c.id])
    ]
    arbiter_out: EvaluationOutput | None = None
    arbiter_label = ""
    if conflicts:
        spec = config.arbiter_model or config.model
        arbiter_provider, arbiter_model = provider_for(spec)
        arbiter_label = arbiter_model
        arbiter_config = config.model_copy(update={"model": arbiter_model, "fallback_model": ""})
        arbiter_out = await run_single(
            snapshot,
            subchecklist(checklist, [ra.criterion_id for ra, _ in conflicts]),
            arbiter_config,
            arbiter_provider,
            extra_user=_arbiter_note(conflicts, config.model, second_model),
        )
    arb_by = {r.criterion_id: r for r in arbiter_out.results} if arbiter_out else {}

    results: list[CriterionResult] = []
    reasons = set(first.review_reasons) | set(second.review_reasons)
    for c in checklist.criteria:
        ra, rb = a_by.get(c.id), b_by.get(c.id)
        if ra is None or rb is None:
            continue
        votes = [_vote(config.model, ra), _vote(second_model, rb)]
        if _same(ra, rb):
            chosen = ra.model_copy(deep=True)
        else:
            decided = arb_by.get(c.id)
            if decided is not None and decided.status is not ResultStatus.FAILED:
                chosen = decided.model_copy(deep=True)
                votes.append(_vote(arbiter_label, decided))
                chosen.review_flags.append("arbitrated")
            else:
                # Arbiter unavailable: the primary judge's answer, flagged.
                chosen = ra.model_copy(deep=True)
                chosen.review_flags.append("judges_disagree")
                reasons.add("arbiter_unavailable")
        chosen.votes = votes
        results.append(chosen)
    assign_confidence(results, [])
    attempts = first.attempts + second.attempts + (arbiter_out.attempts if arbiter_out else [])
    flagged = any(r.review_flags for r in results) or bool(reasons)
    return EvaluationOutput(
        results=results,
        attempts=attempts,
        pipeline=config.pipeline,
        prompt_hash=first.prompt_hash,
        review_status=ReviewStatus.FLAGGED if flagged else ReviewStatus.CLEAR,
        review_reasons=sorted(reasons | ({"judges_disagreed"} if conflicts else set())),
    )


async def run_vote(
    snapshot: ConversationSnapshot,
    checklist: ChecklistVersion,
    config: EvaluatorConfig,
    provider: Provider,
    fallback_provider: Provider | None = None,
    **_,
) -> EvaluationOutput:
    n = max(1, config.votes)
    temperature = config.temperature if config.temperature else 0.4
    runs = await asyncio.gather(
        *(
            run_single(
                snapshot,
                checklist,
                config.model_copy(update={"temperature": temperature}),
                provider,
                fallback_provider,
            )
            for _ in range(n)
        )
    )
    usable = [o for o in runs if _usable(o)]
    if not usable:
        return runs[0]
    results = []
    for c in checklist.criteria:
        candidates = [
            r for o in usable for r in o.results
            if r.criterion_id == c.id and r.status is not ResultStatus.FAILED
        ]
        if not candidates:
            results.append(next(r for r in usable[0].results if r.criterion_id == c.id))
            continue
        keys = Counter(f"{r.status}:{r.answer}" for r in candidates)
        top_key, top_count = keys.most_common(1)[0]
        numeric = [r.answer for r in candidates if isinstance(r.answer, int)]
        if c.levels and top_count * 2 <= len(candidates) and len(numeric) == len(candidates):
            # No majority on a scale: the median level, snapped to an existing one.
            median = statistics.median(numeric)
            levels = sorted(level.value for level in c.levels)
            target = min(levels, key=lambda v: (abs(v - median), v))
            chosen = next((r for r in candidates if r.answer == target), candidates[0])
        else:
            chosen = next(r for r in candidates if f"{r.status}:{r.answer}" == top_key)
        chosen = chosen.model_copy(deep=True)
        chosen.votes = [_vote(config.model, r) for r in candidates]
        chosen.confidence = vote_confidence(chosen.votes, chosen)
        results.append(chosen)
    assign_confidence(results, [])
    merged = _merge(checklist, usable, config.pipeline)
    merged.results = results
    run_level = [r for r in merged.review_reasons if ":" not in r]
    merged.review_status, merged.review_reasons = _review(results, run_level)
    return merged


def _second_ids(checklist: ChecklistVersion, config: EvaluatorConfig) -> list[str]:
    known = [c.id for c in checklist.criteria]
    wanted = [cid for cid in config.second_criteria if cid in known]
    return wanted or [c.id for c in checklist.criteria if c.flag]


async def run_second_opinion(
    snapshot: ConversationSnapshot,
    checklist: ChecklistVersion,
    config: EvaluatorConfig,
    provider: Provider,
    fallback_provider: Provider | None = None,
    provider_for: ProviderFor | None = None,
) -> EvaluationOutput:
    """One full evaluation, then a second model re-checks only the chosen criteria.

    Agreement keeps the answer with two votes; disagreement goes to an arbiter
    that sees both judges' reasoning. A second model that fails changes nothing.
    """
    first = await run_single(snapshot, checklist, config, provider, fallback_provider)
    if not config.second_model or provider_for is None or not _usable(first):
        return first
    ids = _second_ids(checklist, config)
    second_provider, second_model = provider_for(config.second_model)
    second_config = config.model_copy(update={"model": second_model, "fallback_model": ""})
    second = await run_single(snapshot, subchecklist(checklist, ids), second_config, second_provider)
    first.attempts += second.attempts
    if not _usable(second):
        first.review_reasons = sorted(set(first.review_reasons) | {"second_opinion_unavailable"})
        return first

    a_by = {r.criterion_id: r for r in first.results}
    b_by = {r.criterion_id: r for r in second.results if r.status is not ResultStatus.FAILED}
    conflicts = [(a_by[i], b_by[i]) for i in ids if i in a_by and i in b_by and not _same(a_by[i], b_by[i])]
    arbiter_by: dict[str, CriterionResult] = {}
    arbiter_label = ""
    if conflicts:
        arbiter_provider, arbiter_label = provider_for(config.arbiter_model or config.second_model)
        arbiter = await run_single(
            snapshot,
            subchecklist(checklist, [ra.criterion_id for ra, _ in conflicts]),
            config.model_copy(update={"model": arbiter_label, "fallback_model": ""}),
            arbiter_provider,
            extra_user=_arbiter_note(conflicts, config.model, second_model),
        )
        first.attempts += arbiter.attempts
        arbiter_by = {r.criterion_id: r for r in arbiter.results if r.status is not ResultStatus.FAILED}

    results = []
    for result in first.results:
        cid = result.criterion_id
        if cid not in b_by:
            results.append(result)
            continue
        votes = [_vote(config.model, result), _vote(second_model, b_by[cid])]
        if _same(result, b_by[cid]):
            chosen = result
        elif cid in arbiter_by:
            chosen = arbiter_by[cid].model_copy(deep=True)
            votes.append(_vote(arbiter_label, chosen))
            chosen.review_flags.append("arbitrated")
        else:
            chosen = result
            chosen.review_flags.append("judges_disagree")
            first.review_reasons = sorted(set(first.review_reasons) | {"arbiter_unavailable"})
        chosen.votes = votes
        results.append(chosen)
    assign_confidence(results, [])
    first.results = results
    if conflicts:
        first.review_reasons = sorted(set(first.review_reasons) | {"judges_disagreed"})
        first.review_status = ReviewStatus.FLAGGED
    return first


def _self_check_note(output: EvaluationOutput, checklist: ChecklistVersion) -> str:
    from cqa_ai.rubric import effective_notes

    lines = [
        "\n\nСАМОПРОВЕРКА. Ниже твои ответы из первого прохода. Перечитай диалог и правила "
        "рубрики и проверь каждый ответ. Меняй ответ только если он нарушает конкретное "
        "условие или уточнение рубрики; в analysis назови это правило. Иначе оставь ответ.",
        "Частые ловушки этой рубрики:",
    ]
    for criterion in checklist.criteria:
        for note in effective_notes(criterion):
            lines.append(f"- {criterion.id}: {note}")
    lines.append("Ответы первого прохода:")
    for r in output.results:
        value = "na" if r.status is ResultStatus.NOT_APPLICABLE else r.answer
        lines.append(f"- {r.criterion_id}: {value} — {r.justification}")
    return "\n".join(lines)


async def run_self_check(
    snapshot: ConversationSnapshot,
    checklist: ChecklistVersion,
    config: EvaluatorConfig,
    provider: Provider,
    fallback_provider: Provider | None = None,
    **_,
) -> EvaluationOutput:
    """Single, then the same model re-checks its answers against the rubric's traps."""
    first = await run_single(snapshot, checklist, config, provider, fallback_provider)
    if not _usable(first):
        return first
    checked = await run_single(
        snapshot, checklist, config, provider, fallback_provider,
        extra_user=_self_check_note(first, checklist),
    )
    if not _usable(checked):
        first.review_reasons = sorted(set(first.review_reasons) | {"self_check_unavailable"})
        first.attempts += checked.attempts
        return first
    before = {r.criterion_id: r for r in first.results}
    for result in checked.results:
        old = before.get(result.criterion_id)
        if old is None or result.status is ResultStatus.FAILED:
            continue
        result.votes = [_vote(f"{config.model} (1)", old), _vote(f"{config.model} (2)", result)]
        if not _same(old, result):
            result.review_flags.append("self_check_changed")
    # Failed criteria in the check keep the first answer.
    merged = [
        r if r.status is not ResultStatus.FAILED else before.get(r.criterion_id, r)
        for r in checked.results
    ]
    checked.results = merged
    checked.attempts = first.attempts + checked.attempts
    assign_confidence(merged, [])
    reasons = [r for r in checked.review_reasons if ":" not in r]
    checked.review_status, checked.review_reasons = _review(merged, reasons)
    return checked


STRATEGIES: dict[str, Strategy] = {
    "single": lambda s, c, cfg, p, fp=None, **_: run_single(s, c, cfg, p, fp),
    "sections": run_sections,
    "per_criterion": run_per_criterion,
    "two_judges": run_two_judges,
    "vote": run_vote,
    "second_opinion": run_second_opinion,
    "self_check": run_self_check,
}
