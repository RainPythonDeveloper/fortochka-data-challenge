"""HTTP shapes from CONTRACTS.md. Domain models come from `cqa_ai.contracts`.

No model here has an `audio_url` field, so it cannot reach a JSON response.
Additions to the contract: `error` on evaluations, `warnings` on POST /transcripts,
`cached_from` and `evaluator` in the run log, optional `checklist_id` in
EvaluationRequest, `checklists_by_channel` there, null `checklist` on a run that had no checklist for its channel,
POST /checklists, `evaluation_id` in GET /appeals, GET /reports/summary and
GET /evaluations/compare, `stages` in the run log, `current` on a job, and the `latest_*`,
`open_appeals` and `review_status` fields of a conversation summary.
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
    latest_status: Literal["done", "failed"] | None = None
    latest_error: str | None = None
    latest_reasons: list[str] = Field(default_factory=list)
    latest_evaluated_at: str | None = None
    review_status: Literal["clear", "flagged"] | None = None
    open_appeals: int = 0


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
    checklist_id: str | None = None  # empty: chosen per dialogue by its channel
    checklists_by_channel: dict[str, str] | None = None  # channels left out are chosen as above
    version: int | None = None
    force: bool = False


StageId = Literal["parse", "model", "validate", "score"]


class JobStage(BaseModel):
    """What one dialogue of a running job is doing right now."""

    conversation_id: str
    stage: StageId
    started_at: str


class Job(BaseModel):
    id: str
    status: Literal["queued", "running", "done", "failed"]
    total: int
    done: int
    failed: int
    evaluation_ids: list[str]
    errors: list[str]
    current: list[JobStage] = Field(default_factory=list)


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


class RunStage(BaseModel):
    id: StageId
    ms: float


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
    stages: list[RunStage] | None = None  # absent on runs saved before the field


class EvaluationRun(EvaluationSummary):
    results: list[CriterionResult]
    score: ScoreSummary
    final_results: list[CriterionResult]
    final_score: ScoreSummary
    checklist: ChecklistVersion | None
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
    # Context for the reviewer's list; filled when listing, optional elsewhere.
    conversation_id: str | None = None
    criterion_title: str | None = None
    model_status: str | None = None
    model_answer: str | int | None = None


class ReportBucket(BaseModel):
    key: str
    conversations: int
    evaluated: int
    failed: int
    not_evaluated: int


class ReportChecklist(BaseModel):
    checklist_id: str
    version: int
    conversations: int


class ReportEvaluator(BaseModel):
    provider: str
    model: str
    fallback_model: str | None = None
    prompt_version: str | None = None
    pipeline: str
    temperature: float | None
    max_output_tokens: int
    conversations: int


class ReportSummary(BaseModel):
    """Dialogue counts use the latest run of each dialogue. Latency and cost use every
    run with a model attempt, so repeats and retries are not hidden, while cache hits
    and calls that were never sent do not distort them."""

    group_id: str | None
    generated_at: str
    conversations: int
    evaluated: int
    failed: int
    not_evaluated: int
    partial: int
    by_language: list[ReportBucket]
    by_channel: list[ReportBucket]
    runs: int
    failed_runs: int
    cache_hits: int
    model_attempts: int
    avg_latency_ms: float | None
    total_cost_usd: float | None
    runs_without_cost: int
    checklists: list[ReportChecklist]
    evaluators: list[ReportEvaluator]
    mock_used: bool


class CompareSide(BaseModel):
    id: str
    checklist_id: str
    checklist_version: int
    total: float | None
    final_total: float | None
    gross_error: bool
    final_gross_error: bool
    cache_hit: bool
    created_at: str


class CompareValue(BaseModel):
    status: str
    answer: str | int | None
    weight: float
    effective_weight: float | None
    points: float | None


class CompareCriterion(BaseModel):
    criterion_id: str
    title: str
    a: CompareValue | None
    b: CompareValue | None
    answer_changed: bool
    points_changed: bool
    points_delta: float | None


class EvaluationCompare(BaseModel):
    """Original automatic results of two runs of one dialogue."""

    conversation_id: str
    a: CompareSide
    b: CompareSide
    same_content: bool
    same_rubric: bool
    total_delta: float | None
    final_total_delta: float | None
    changed_criteria: list[str]
    criteria: list[CompareCriterion]
