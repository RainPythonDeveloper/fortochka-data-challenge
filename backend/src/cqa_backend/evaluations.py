"""Evaluation jobs, the reuse cache and stored runs.

Scores come from `calculate_score` only. A failure is stored as a failed run with
its reason, never as a zero. Each result is committed as soon as it is ready.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import sqlite3
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from cqa_ai import calculate_score, checklist_hash, content_hash
from cqa_ai.contracts import (
    ChecklistVersion,
    ConversationSnapshot,
    CriterionResult,
    EvaluationOutput,
    EvaluatorConfig,
    ResultStatus,
    ReviewStatus,
    ScoreSummary,
)
from pydantic import ValidationError

from cqa_backend.checklists import get_checklist
from cqa_backend.config import Settings, resolve_evaluator_config
from cqa_backend.db import Database, now_iso
from cqa_backend.errors import ApiError, describe_validation
from cqa_backend.redact import redact
from cqa_backend.schemas import (
    EvaluationRequest,
    EvaluationRun,
    EvaluationSummary,
    Job,
    RunLog,
)

logger = logging.getLogger(__name__)

Evaluator = Callable[
    [ConversationSnapshot, ChecklistVersion, EvaluatorConfig], Awaitable[EvaluationOutput]
]
MAX_ERROR_LENGTH = 500


def evaluator_key(config: EvaluatorConfig) -> str:
    return hashlib.sha256(config.model_dump_json().encode("utf-8")).hexdigest()


def describe_failure(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        text = describe_validation(exc)
    elif isinstance(exc, TimeoutError):
        text = "Превышено время ожидания оценки"
    else:
        text = str(exc) or type(exc).__name__
    return redact(text)[:MAX_ERROR_LENGTH]


@dataclass
class Draft:
    """Everything about one run before it is written."""

    results: list[CriterionResult] = field(default_factory=list)
    score: ScoreSummary = field(default_factory=ScoreSummary)
    status: str = "done"
    error: str | None = None
    review_status: str = ReviewStatus.CLEAR.value
    review_reasons: list[str] = field(default_factory=list)
    log: dict[str, Any] = field(default_factory=dict)
    key: str | None = None


class EvaluationService:
    def __init__(self, db: Database, settings: Settings, evaluator: Evaluator) -> None:
        self.db = db
        self.settings = settings
        self.evaluator = evaluator
        self.semaphore = asyncio.Semaphore(settings.cqa_eval_concurrency)
        self.tasks: set[asyncio.Task[None]] = set()

    # Job lifecycle

    def create_job(self, request: EvaluationRequest) -> Job:
        checklist = get_checklist(self.db, request.checklist_id, request.version)
        conversation_ids = list(dict.fromkeys(request.conversation_ids))
        job_id = str(uuid.uuid4())
        with self.db.tx() as conn:
            marks = ",".join("?" * len(conversation_ids))
            known = {
                row["id"]
                for row in conn.execute(
                    f"SELECT id FROM conversations WHERE id IN ({marks})", conversation_ids
                )
            }
            unknown = [item for item in conversation_ids if item not in known]
            if unknown:
                raise ApiError(404, f"Диалоги не найдены: {redact(', '.join(unknown))[:300]}")
            conn.execute(
                "INSERT INTO jobs VALUES (?, 'queued', ?, ?, ?, NULL, ?)",
                (job_id, checklist.checklist_id, checklist.version, request.force, now_iso()),
            )
            conn.executemany(
                "INSERT INTO job_items VALUES (?, ?, ?, 'pending', NULL, NULL)",
                [(job_id, index, item) for index, item in enumerate(conversation_ids)],
            )
        self._spawn(job_id)
        return self.get_job(job_id)

    def get_job(self, job_id: str) -> Job:
        with self.db.read() as conn:
            job = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if job is None:
                raise ApiError(404, "Задача не найдена")
            items = conn.execute(
                "SELECT * FROM job_items WHERE job_id = ? ORDER BY position", (job_id,)
            ).fetchall()
        errors = [f"{row['conversation_id']}: {row['error']}" for row in items if row["error"]]
        if job["error"]:
            errors.append(job["error"])
        return Job(
            id=job["id"],
            status=job["status"],
            total=len(items),
            done=sum(row["status"] == "done" for row in items),
            failed=sum(row["status"] == "failed" for row in items),
            evaluation_ids=[row["evaluation_id"] for row in items if row["evaluation_id"]],
            errors=errors,
        )

    def _spawn(self, job_id: str) -> None:
        task = asyncio.create_task(self._run_job(job_id))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def recover(self) -> int:
        """Resume unfinished jobs after a restart. Finished items are not repeated."""
        with self.db.read() as conn:
            rows = conn.execute(
                "SELECT id FROM jobs WHERE status IN ('queued', 'running')"
            ).fetchall()
        for row in rows:
            logger.info("resuming job %s", row["id"])
            self._spawn(row["id"])
        return len(rows)

    async def shutdown(self) -> None:
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _run_job(self, job_id: str) -> None:
        try:
            await asyncio.to_thread(self._set_job, job_id, "running", None)
            job, pending = await asyncio.to_thread(self._load_pending, job_id)
            checklist = await asyncio.to_thread(
                get_checklist, self.db, job["checklist_id"], job["checklist_version"]
            )
            outcomes = await asyncio.gather(
                *(
                    self._process(job_id, position, conversation_id, checklist, bool(job["force"]))
                    for position, conversation_id in pending
                ),
                return_exceptions=True,
            )
            for outcome in outcomes:
                if isinstance(outcome, asyncio.CancelledError):
                    raise outcome
            crashed = [item for item in outcomes if isinstance(item, Exception)]
            summary = await asyncio.to_thread(self.get_job, job_id)
            if crashed:
                logger.error("job %s: storage failure %s", job_id, type(crashed[0]).__name__)
                message = f"Часть диалогов не обработана: {describe_failure(crashed[0])}"
                await asyncio.to_thread(self._set_job, job_id, "failed", message)
            elif summary.total and summary.failed == summary.total:
                await asyncio.to_thread(self._set_job, job_id, "failed", None)
            else:
                await asyncio.to_thread(self._set_job, job_id, "done", None)
        except Exception as exc:  # noqa: BLE001 - a job must always reach a final state
            logger.error("job %s crashed: %s", job_id, type(exc).__name__)
            self._set_job(job_id, "failed", f"Задача прервана: {describe_failure(exc)}")

    def _set_job(self, job_id: str, status: str, error: str | None) -> None:
        with self.db.tx() as conn:
            conn.execute("UPDATE jobs SET status = ?, error = ? WHERE id = ?", (status, error, job_id))

    def _load_pending(self, job_id: str) -> tuple[sqlite3.Row, list[tuple[int, str]]]:
        with self.db.read() as conn:
            job = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            rows = conn.execute(
                "SELECT position, conversation_id FROM job_items "
                "WHERE job_id = ? AND status = 'pending' ORDER BY position",
                (job_id,),
            ).fetchall()
        return job, [(row["position"], row["conversation_id"]) for row in rows]

    # One dialogue

    async def _process(
        self,
        job_id: str,
        position: int,
        conversation_id: str,
        checklist: ChecklistVersion,
        force: bool,
    ) -> None:
        async with self.semaphore:
            snapshot = await asyncio.to_thread(self._load_snapshot, conversation_id)
            hashes = {
                "content_hash": content_hash(snapshot),
                "checklist_hash": checklist_hash(checklist),
            }
            try:
                draft = await self._evaluate(snapshot, checklist, force, hashes)
            except Exception as exc:  # noqa: BLE001 - one dialogue must not stop the batch
                logger.warning("evaluation of %s failed: %s", conversation_id, type(exc).__name__)
                draft = Draft(
                    status="failed",
                    error=describe_failure(exc),
                    review_status=ReviewStatus.FLAGGED.value,
                    review_reasons=["evaluation_failed"],
                    log=getattr(exc, "run_log", {}),
                )
            await asyncio.to_thread(
                self._save, job_id, position, snapshot, checklist, hashes, draft
            )

    def _load_snapshot(self, conversation_id: str) -> ConversationSnapshot:
        with self.db.read() as conn:
            row = conn.execute(
                "SELECT snapshot_json FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()
        # Stored without audio_url: the signed link is not needed to score the text.
        return ConversationSnapshot.model_validate_json(row["snapshot_json"])

    async def _evaluate(
        self,
        snapshot: ConversationSnapshot,
        checklist: ChecklistVersion,
        force: bool,
        hashes: dict[str, str],
    ) -> Draft:
        config = resolve_evaluator_config(self.settings)
        key = evaluator_key(config)
        evaluator_log = config.model_dump(mode="json")
        if not force:
            source = await asyncio.to_thread(self._find_cached, hashes, key)
            if source is not None:
                return self._from_cache(source, snapshot, checklist, key, evaluator_log)

        started = time.perf_counter()
        output = await asyncio.wait_for(
            self.evaluator(snapshot, checklist, config),
            timeout=self.settings.cqa_eval_timeout_s,
        )
        costs = [item.cost_usd for item in output.attempts if item.cost_usd is not None]
        log = {
            "prompt_hash": output.prompt_hash,
            "pipeline": output.pipeline,
            "attempts": [item.model_dump(mode="json") for item in output.attempts],
            "latency_ms": round((time.perf_counter() - started) * 1000),
            "cost_usd": sum(costs) if costs else None,
            "evaluator": evaluator_log,
        }
        try:
            score = calculate_score(checklist, output.results)
        except Exception as exc:
            exc.run_log = log  # type: ignore[attr-defined]
            raise
        return self._draft(
            snapshot, checklist, output.results, score, output.review_status.value,
            output.review_reasons, log, key,
        )

    def _find_cached(self, hashes: dict[str, str], key: str) -> sqlite3.Row | None:
        with self.db.read() as conn:
            return conn.execute(
                """
                SELECT id, results_json, review_status, review_reasons_json, log_json
                FROM evaluation_runs
                WHERE content_hash = ? AND checklist_hash = ? AND evaluator_key = ?
                  AND status = 'done' AND cacheable = 1
                ORDER BY rowid DESC LIMIT 1
                """,
                (hashes["content_hash"], hashes["checklist_hash"], key),
            ).fetchone()

    def _from_cache(
        self,
        source: sqlite3.Row,
        snapshot: ConversationSnapshot,
        checklist: ChecklistVersion,
        key: str,
        evaluator_log: dict[str, Any],
    ) -> Draft:
        """Reuse the model answers. The score is always computed with the current
        version, which is what makes a weight-only change free of model calls."""
        results = [CriterionResult.model_validate(item) for item in json.loads(source["results_json"])]
        source_log = json.loads(source["log_json"])
        log = {
            "prompt_hash": source_log.get("prompt_hash", ""),
            "pipeline": source_log.get("pipeline", ""),
            "attempts": [],
            "cache_hit": True,
            "cost_usd": 0.0,
            "cached_from": source_log.get("cached_from") or source["id"],
            "evaluator": evaluator_log,
        }
        return self._draft(
            snapshot, checklist, results, calculate_score(checklist, results),
            source["review_status"], json.loads(source["review_reasons_json"]), log, key,
        )

    @staticmethod
    def _draft(
        snapshot: ConversationSnapshot,
        checklist: ChecklistVersion,
        results: list[CriterionResult],
        score: ScoreSummary,
        review_status: str,
        reasons: list[str],
        log: dict[str, Any],
        key: str,
    ) -> Draft:
        reasons = list(reasons)
        if score.is_partial and "partial_result" not in reasons:
            reasons.append("partial_result")
        if checklist.channels and snapshot.channel not in checklist.channels:
            if "channel_not_in_checklist" not in reasons:
                reasons.append("channel_not_in_checklist")
        return Draft(
            results=results,
            score=score,
            review_status=ReviewStatus.FLAGGED.value if reasons else review_status,
            review_reasons=reasons,
            log=log,
            key=key,
        )

    def _save(
        self,
        job_id: str,
        position: int,
        snapshot: ConversationSnapshot,
        checklist: ChecklistVersion,
        hashes: dict[str, str],
        draft: Draft,
    ) -> None:
        run_id = str(uuid.uuid4())
        results = json.dumps([item.model_dump(mode="json") for item in draft.results], ensure_ascii=False)
        score = draft.score.model_dump_json()
        log = RunLog(run_id=run_id, **hashes, **draft.log).model_dump_json()
        cacheable = draft.status == "done" and not any(
            item.status is ResultStatus.FAILED for item in draft.results
        )
        with self.db.tx() as conn:
            conn.execute(
                """
                INSERT INTO evaluation_runs VALUES
                    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id, snapshot.conversation_id, checklist.checklist_id, checklist.version,
                    checklist.model_dump_json(), snapshot.model_dump_json(exclude={"audio_url"}),
                    draft.status, draft.error, results, score, results, score,
                    draft.review_status, json.dumps(draft.review_reasons, ensure_ascii=False), log,
                    hashes["content_hash"], hashes["checklist_hash"], draft.key,
                    int(cacheable), now_iso(),
                ),
            )
            conn.execute(
                "UPDATE job_items SET status = ?, evaluation_id = ?, error = ? "
                "WHERE job_id = ? AND position = ?",
                (draft.status, run_id, draft.error, job_id, position),
            )

    # Reads

    def list_runs(self, conversation_id: str | None) -> list[EvaluationSummary]:
        clause, params = ("WHERE conversation_id = ?", (conversation_id,)) if conversation_id else ("", ())
        with self.db.read() as conn:
            rows = conn.execute(
                f"SELECT * FROM evaluation_runs {clause} ORDER BY rowid DESC", params
            ).fetchall()
        return [EvaluationSummary(**run_summary(row)) for row in rows]

    def get_run(self, run_id: str) -> EvaluationRun:
        with self.db.read() as conn:
            row = conn.execute("SELECT * FROM evaluation_runs WHERE id = ?", (run_id,)).fetchone()
        if row is None:
            raise ApiError(404, "Оценка не найдена")
        return EvaluationRun(
            **run_summary(row),
            results=json.loads(row["results_json"]),
            score=json.loads(row["score_json"]),
            final_results=json.loads(row["final_results_json"]),
            final_score=json.loads(row["final_score_json"]),
            checklist=json.loads(row["checklist_json"]),
            review_status=row["review_status"],
            review_reasons=json.loads(row["review_reasons_json"]),
            log=json.loads(row["log_json"]),
        )


def run_summary(row: sqlite3.Row) -> dict[str, Any]:
    score = json.loads(row["score_json"])
    final = json.loads(row["final_score_json"])
    return {
        "id": row["id"],
        "conversation_id": row["conversation_id"],
        "checklist_id": row["checklist_id"],
        "checklist_version": row["checklist_version"],
        "status": row["status"],
        "total": score.get("total"),
        "final_total": final.get("total"),
        "gross_error": bool(final.get("gross_error")),
        "created_at": row["created_at"],
        "error": row["error"],
    }
