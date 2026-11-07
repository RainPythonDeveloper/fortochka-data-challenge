"""Per-criterion confidence, computed in code from what the run observed.

With several judges or repeats the share of agreeing votes is the confidence.
With one judge it starts at 1 and drops for each sign of trouble: a contract
repair, the fallback model, rejected evidence, or the model's own review flag.
Below LOW_CONFIDENCE the criterion is flagged for a human reviewer. The answer
itself never changes here.
"""

from __future__ import annotations

from collections import Counter

from cqa_ai.contracts import CriterionResult, JudgeVote, ResultStatus

LOW_CONFIDENCE = 0.67
LOW_CONFIDENCE_FLAG = "low_confidence"

_PENALTIES_RUN = {"contract_repair_used": 0.15, "served_by_fallback_model": 0.1}
_SYSTEM_FLAGS = {
    "evidence_missing": 0.15,
    "evidence_rejected": 0.15,
    "evidence_internal_turn": 0.1,
    # Code found a personal-contact or payment phrase, the model saw no violation.
    "code_hint_conflict": 0.4,
}
_MODEL_FLAG = 0.25


def _vote_key(vote: JudgeVote) -> str:
    return f"{vote.status}:{vote.answer}"


def vote_confidence(votes: list[JudgeVote], chosen: CriterionResult) -> float:
    counts = Counter(_vote_key(v) for v in votes)
    key = f"{chosen.status}:{chosen.answer}"
    return round(counts.get(key, 0) / len(votes), 2) if votes else 1.0


def assign_confidence(results: list[CriterionResult], run_flags: list[str]) -> None:
    run_penalty = sum(_PENALTIES_RUN.get(flag, 0) for flag in set(run_flags))
    for result in results:
        if result.status is ResultStatus.FAILED:
            result.confidence = 0.0
            continue
        if result.votes:
            value = vote_confidence(result.votes, result)
            # Judges agreeing with each other does not outweigh a contradicting code fact.
            if "code_hint_conflict" in result.review_flags:
                value -= _SYSTEM_FLAGS["code_hint_conflict"]
        else:
            value = 1.0 - run_penalty
            model_flags = [
                f for f in result.review_flags if f not in _SYSTEM_FLAGS and f != LOW_CONFIDENCE_FLAG
            ]
            value -= sum(_SYSTEM_FLAGS.get(f, 0) for f in set(result.review_flags))
            if model_flags:
                value -= _MODEL_FLAG
        result.confidence = round(max(0.0, min(1.0, value)), 2)
        if result.confidence < LOW_CONFIDENCE and LOW_CONFIDENCE_FLAG not in result.review_flags:
            result.review_flags.append(LOW_CONFIDENCE_FLAG)
