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
