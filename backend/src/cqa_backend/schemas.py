"""HTTP shapes from CONTRACTS.md. Domain models come from `cqa_ai.contracts`.

No model here has an `audio_url` field, so it cannot reach a JSON response.
Additions to the contract: `error` on evaluations, `warnings` on POST /transcripts,
`cached_from` and `evaluator` in the run log.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from cqa_ai.contracts import (
    ChecklistVersion,
    CriterionResult,
    ModelAttempt,
    ScoreSummary,
    Turn,
)
from pydantic import BaseModel, Field, StrictInt, StringConstraints

NonEmpty = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class ImportRequest(BaseModel):
    group_id: str | None = None


class ImportResult(BaseModel):
    group_id: str
    imported: int
    skipped: int
    conversation_ids: list[str]
    errors: list[str]


class ConversationSummary(BaseModel):
    id: str
    channel: str
    language: str
    turn_count: int
    has_audio: bool
    group_id: str | None
    latest_evaluation_id: str | None
    latest_total: float | None
    gross_error: bool


class ConversationDetail(ConversationSummary):
    turns: list[Turn]


class TranscriptResult(ConversationSummary):
    warnings: list[str] = Field(default_factory=list)


class ChecklistSummary(BaseModel):
    checklist_id: str
    title: str
    latest_version: int
    channels: list[str]


class EvaluationRequest(BaseModel):
    conversation_ids: list[NonEmpty] = Field(min_length=1)
    checklist_id: str
    version: int | None = None
    force: bool = False


class Job(BaseModel):
    id: str
    status: Literal["queued", "running", "done", "failed"]
    total: int
    done: int
    failed: int
    evaluation_ids: list[str]
    errors: list[str]


class EvaluationSummary(BaseModel):
    id: str
    conversation_id: str
    checklist_id: str
    checklist_version: int
    status: Literal["done", "failed"]
    total: float | None
    final_total: float | None
    gross_error: bool
    created_at: str
    error: str | None = None


class RunLog(BaseModel):
    run_id: str
    content_hash: str
    checklist_hash: str
    prompt_hash: str = ""
    pipeline: str = ""
    attempts: list[ModelAttempt] = Field(default_factory=list)
    cache_hit: bool = False
    latency_ms: int | None = None
    cost_usd: float | None = None
    cached_from: str | None = None
    evaluator: dict[str, Any] | None = None


class EvaluationRun(EvaluationSummary):
    results: list[CriterionResult]
    score: ScoreSummary
    final_results: list[CriterionResult]
    final_score: ScoreSummary
    checklist: ChecklistVersion
    review_status: Literal["clear", "flagged"]
    review_reasons: list[str]
    log: RunLog


class AppealCreate(BaseModel):
    evaluation_id: str
    criterion_id: str
    comment: NonEmpty


class DecisionCreate(BaseModel):
    decision: Literal["confirm", "change"]
    # StrictInt: JSON `true` must not turn into scale level 1.
    new_answer: Literal["yes", "no"] | StrictInt | None = None
    new_status: Literal["assessed", "not_applicable"] | None = None
    reason: NonEmpty
    reviewer: NonEmpty


class Decision(DecisionCreate):
    decided_at: str


class Appeal(BaseModel):
    id: str
    evaluation_id: str
    criterion_id: str
    comment: str
    status: Literal["open", "decided"]
    created_at: str
    decision: Decision | None = None
