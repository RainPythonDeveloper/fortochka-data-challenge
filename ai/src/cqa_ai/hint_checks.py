"""Human-in-the-loop safety net: a code fact that contradicts the model's answer.

Only a flag is added; the model's answer is never changed. The check applies to a
violation flag only while it keeps one of the shipped meanings (the official
"gross errors" criterion): if the organizers replace it with another violation,
the personal-contact fact says nothing about it and the check stays silent.
"""

from __future__ import annotations

from functools import cache
from importlib import resources

from cqa_ai.annotate import ConversationFacts
from cqa_ai.contracts import ChecklistVersion, CriterionResult, ResultStatus
from cqa_ai.rubric import meaning_fingerprint

HINT_CONFLICT_FLAG = "code_hint_conflict"


@cache
def _official_flag_meanings() -> frozenset[str]:
    meanings: set[str] = set()
    folder = resources.files("cqa_ai") / "checklists"
    for item in folder.iterdir():
        if not item.name.endswith(".json"):
            continue
        checklist = ChecklistVersion.model_validate_json(item.read_text(encoding="utf-8"))
        meanings.update(meaning_fingerprint(c) for c in checklist.criteria if c.flag)
    return frozenset(meanings)


def check_hints(
    results: list[CriterionResult], checklist: ChecklistVersion, facts: ConversationFacts
) -> None:
    if not facts.personal_contact_turns:
        return
    official = _official_flag_meanings()
    flag_ids = {
        c.id for c in checklist.criteria if c.flag and meaning_fingerprint(c) in official
    }
    for result in results:
        if (
            result.criterion_id in flag_ids
            and result.status is ResultStatus.ASSESSED
            and result.answer == "no"
            and HINT_CONFLICT_FLAG not in result.review_flags
        ):
            result.review_flags.append(HINT_CONFLICT_FLAG)


def _fact_turns(facts: ConversationFacts) -> dict[str, set[int]]:
    turns: dict[str, set[int]] = {
        "первая реплика оператора": {facts.first_operator_turn},
        "последняя реплика оператора": {facts.last_operator_turn},
        "событие завершения": {facts.end_event_turn},
        "передача оператору": {facts.escalation_turn},
        "подтверждение личности": set(facts.identity_confirmed_turns),
        "реплики клиента до оператора": set(
            facts.client_turns_before_operator + facts.client_turns_while_waiting
        ),
        "просьба подождать": set(facts.operator_wait_turns),
        "пауза больше 3 минут": {p.to_turn for p in facts.long_pauses},
        "личный контакт или оплата": set(facts.personal_contact_turns),
        "удержание": {
            i for r in facts.hold_ranges for i in range(r.from_turn, r.to_turn + 1)
        },
    }
    return {name: {t for t in found if t is not None} for name, found in turns.items()}


def attach_facts_used(results: list[CriterionResult], facts: ConversationFacts) -> None:
    """Record which code facts (W6) sit on the turns a decision cites."""
    fact_turns = _fact_turns(facts)
    for result in results:
        cited = {e.turn_index for e in result.evidence}
        if result.expected_at_turn is not None:
            cited.add(result.expected_at_turn)
        used = [name for name, found in fact_turns.items() if found & cited]
        result.facts_used = used or None
