"""Shared domain contracts.

Every part of the project talks through these models. The frontend mirrors them
in `frontend/src/api/types.ts`. Changing a field here is a contract change: see
CONTRACTS.md before doing it.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class CriterionType(StrEnum):
    BOOLEAN = "boolean"
    SCALE = "scale"


class ResultStatus(StrEnum):
    ASSESSED = "assessed"
    NOT_APPLICABLE = "not_applicable"
    UNASSESSABLE = "unassessable"
    FAILED = "failed"


class ReviewStatus(StrEnum):
    CLEAR = "clear"
    FLAGGED = "flagged"


BooleanAnswer = Literal["yes", "no"]
Answer = BooleanAnswer | int | None


class Turn(BaseModel):
    """One transcript turn. `index` is the only stable address of a turn."""

    index: int
    timestamp: str
    speaker: str
    text: str


class ConversationSnapshot(BaseModel):
    """An immutable copy of one dialogue as it was evaluated."""

    conversation_id: str
    channel: str
    language: str
    turns: list[Turn]
    audio_url: str | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


class Section(BaseModel):
    id: str
    title: str


class ScaleLevel(BaseModel):
    value: int
    text: str


class Criterion(BaseModel):
    id: str
    section: str
    title: str
    type: CriterionType
    weight: float = Field(ge=0)
    scored: bool = True
    flag: str | None = None
    allow_na: bool = False
    yes_when: str | None = None
    prompt: str | None = None
    na_when: str | None = None
    levels: list[ScaleLevel] = Field(default_factory=list)
    team_notes: list[str] = Field(default_factory=list)
    disabled_notes: list[str] = Field(default_factory=list)  # switched off, including defaults

    @model_validator(mode="after")
    def check_shape(self) -> Criterion:
        if self.allow_na and not self.na_when:
            raise ValueError(f"{self.id}: allow_na requires na_when")
        if self.type is CriterionType.SCALE:
            values = [level.value for level in self.levels]
            if len(values) < 2 or len(set(values)) != len(values):
                raise ValueError(f"{self.id}: a scale needs at least two distinct levels")
            if max(values) <= 0:
                raise ValueError(f"{self.id}: the top scale level must be positive")
        elif self.levels:
            raise ValueError(f"{self.id}: a boolean criterion cannot have levels")
        if not self.scored and self.weight != 0:
            raise ValueError(f"{self.id}: an unscored criterion must have weight 0")
        return self

    @property
    def max_level(self) -> int:
        return max(level.value for level in self.levels)


class ChecklistVersion(BaseModel):
    checklist_id: str
    version: int = Field(ge=1)
    title: str
    channels: list[str] = Field(default_factory=list)
    excluded_from_scoring: list[str] = Field(default_factory=list)
    sections: list[Section]
    criteria: list[Criterion]

    @model_validator(mode="after")
    def check_references(self) -> ChecklistVersion:
        ids = [criterion.id for criterion in self.criteria]
        if not ids or len(set(ids)) != len(ids):
            raise ValueError("criteria must be non-empty with unique ids")
        section_ids = {section.id for section in self.sections}
        for criterion in self.criteria:
            if criterion.section not in section_ids:
                raise ValueError(f"{criterion.id}: unknown section {criterion.section}")
        return self


class Evidence(BaseModel):
    turn_index: int
    quote: str


class TurnRange(BaseModel):
    from_turn: int
    to_turn: int


class JudgeVote(BaseModel):
    """One judge's (or one repeat's) answer for a criterion, kept for the trace."""

    model: str
    status: ResultStatus
    answer: Answer = None
    justification: str = ""


class CriterionResult(BaseModel):
    """One decision. `answer` is null unless `status` is `assessed`."""

    criterion_id: str
    status: ResultStatus
    answer: Answer = None
    justification: str = ""
    evidence: list[Evidence] = Field(default_factory=list)
    reviewed_range: TurnRange | None = None
    expected_at_turn: int | None = None
    review_flags: list[str] = Field(default_factory=list)
    # W7 decision trace. All optional, so older results and clients stay valid.
    analysis: str | None = None  # the model's short reasoning before the answer
    rule_ref: str | None = None  # "yes_when" | "na_when" | "level:15" | "note:2" | "prompt"
    rule_text: str | None = None  # the rubric text rule_ref points to, as the model saw it
    facts_used: list[str] | None = None  # code facts (W6) whose turns the decision cites
    alternative: str | None = None  # scales: what kept the answer from the next level up
    confidence: float | None = None  # 0..1, computed in code, never by the model
    votes: list[JudgeVote] | None = None  # each judge or repeat, when there were several


class CriterionScore(BaseModel):
    criterion_id: str
    status: ResultStatus
    answer: Answer = None
    weight: float
    effective_weight: float | None = None
    points: float | None = None


class SectionScore(BaseModel):
    section_id: str
    title: str
    earned: float
    possible: float
    percent: float | None = None
    flags: list[str] = Field(default_factory=list)


class ScoreSummary(BaseModel):
    """`total` is null when no weighted criterion applies or a result is missing.

    A missing weight is never treated as N/A: `partial_total` keeps it in the
    denominator, so it is a lower bound and not a substitute for `total`.
    """

    total: float | None = None
    partial_total: float | None = None
    is_partial: bool = False
    missing_criteria: list[str] = Field(default_factory=list)
    gross_error: bool = False
    gross_error_criteria: list[str] = Field(default_factory=list)
    criteria: list[CriterionScore] = Field(default_factory=list)
    sections: list[SectionScore] = Field(default_factory=list)


class ModelAttempt(BaseModel):
    """One model call. Every attempt is kept so the run can be audited and priced."""

    provider: str
    model: str
    role: str = "primary"
    attempt: int = 1
    latency_ms: int | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    # What the same call would cost on a paid provider (see providers/profiles.py).
    paid_equivalent_usd: float | None = None
    # Time spent waiting for the provider's rate-limit slot before the call.
    queue_wait_ms: int | None = None
    valid: bool = False
    errors: list[str] = Field(default_factory=list)


def _current_prompt_version() -> str:
    from cqa_ai.prompt import prompt_version

    return prompt_version()


class EvaluatorConfig(BaseModel):
    """Everything that decides a result, so it can serve as a cache key.

    `prompt_version` is computed from the prompt text: any prompt change gets a
    new key by itself, and an old result can never be reused by mistake.
    """

    provider: str = "mock"
    model: str = "mock"
    fallback_model: str | None = None
    pipeline: str = "single"
    temperature: float | None = 0
    max_output_tokens: int = 8000
    # Ensembles (W5). `provider:model` strings; empty means "not used".
    second_model: str | None = None
    arbiter_model: str | None = None
    votes: int = 3
    # second_opinion: criteria the second model re-checks. Empty: violation flags only.
    second_criteria: list[str] = Field(default_factory=list)
    prompt_version: str = Field(default_factory=_current_prompt_version)


class EvaluationOutput(BaseModel):
    results: list[CriterionResult]
    attempts: list[ModelAttempt] = Field(default_factory=list)
    pipeline: str = "single"
    prompt_hash: str = ""
    review_status: ReviewStatus = ReviewStatus.CLEAR
    review_reasons: list[str] = Field(default_factory=list)
    # facts_first: what the first call extracted, kept for the trace (W7).
    extracted_facts: dict[str, Any] | None = None
