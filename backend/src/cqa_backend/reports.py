"""Read-only reports: the honest summary of a selection and the comparison of two runs."""

from __future__ import annotations

import json
import sqlite3
from collections import Counter
from typing import Any

from cqa_ai.contracts import ChecklistVersion

from cqa_backend.db import Database, now_iso
from cqa_backend.errors import ApiError
from cqa_backend.schemas import (
    CompareCriterion,
    CompareSide,
    CompareValue,
    EvaluationCompare,
    ReportBucket,
    ReportChecklist,
    ReportEvaluator,
    ReportSummary,
)

MOCK_PROVIDER = "mock"


def _buckets(rows: list[dict[str, Any]], field: str) -> list[ReportBucket]:
    buckets = []
    for key in sorted({row[field] for row in rows}):
        members = [row for row in rows if row[field] == key]
        states = Counter(row["status"] for row in members)
        buckets.append(
            ReportBucket(
                key=key,
                conversations=len(members),
                evaluated=states["done"],
                failed=states["failed"],
                not_evaluated=states[None],
            )
        )
    return buckets


def summary(db: Database, group_id: str | None) -> ReportSummary:
    where, params = ("WHERE c.group_id = ?", (group_id,)) if group_id else ("", ())
    with db.read() as conn:
        latest = conn.execute(
            f"""
            SELECT c.id, c.channel, c.language, r.status, r.checklist_id, r.checklist_version,
                   r.score_json, r.log_json
            FROM conversations c
            LEFT JOIN evaluation_runs r ON r.rowid = (
                SELECT MAX(rowid) FROM evaluation_runs WHERE conversation_id = c.id
            )
            {where}
            """,
            params,
        ).fetchall()
        runs = conn.execute(
            f"""
            SELECT r.status, r.log_json FROM evaluation_runs r
            JOIN conversations c ON c.id = r.conversation_id
            {where}
            """,
            params,
        ).fetchall()

    rows = [dict(row) for row in latest]
    states = Counter(row["status"] for row in rows)
    logs = [json.loads(row["log_json"]) for row in runs]
    # A cache hit or a refused call made no model call: no latency, no cost.
    called = [log for log in logs if log.get("attempts")]
    latencies = [log["latency_ms"] for log in called if log.get("latency_ms") is not None]
    costs = [log["cost_usd"] for log in called if log.get("cost_usd") is not None]

    checklists: Counter[tuple[str, int]] = Counter()
    evaluators: Counter[str] = Counter()
    partial = 0
    for row in rows:
        if row["status"] is None:
            continue
        if row["checklist_id"]:
            checklists[(row["checklist_id"], row["checklist_version"])] += 1
        evaluator = json.loads(row["log_json"]).get("evaluator")
        if evaluator:
            evaluators[json.dumps(evaluator, sort_keys=True)] += 1
        partial += bool(json.loads(row["score_json"]).get("is_partial"))

    report_evaluators = [
        ReportEvaluator(**json.loads(key), conversations=count)
        for key, count in sorted(evaluators.items())
    ]
    used = [log.get("evaluator") or {} for log in logs]
    return ReportSummary(
        group_id=group_id,
        generated_at=now_iso(),
        conversations=len(rows),
        evaluated=states["done"],
        failed=states["failed"],
        not_evaluated=states[None],
        partial=partial,
        by_language=_buckets(rows, "language"),
        by_channel=_buckets(rows, "channel"),
        runs=len(logs),
        failed_runs=sum(row["status"] == "failed" for row in runs),
        cache_hits=sum(bool(log.get("cache_hit")) for log in logs),
        model_attempts=sum(len(log.get("attempts") or []) for log in logs),
        avg_latency_ms=round(sum(latencies) / len(latencies), 1) if latencies else None,
        total_cost_usd=round(sum(costs), 6) if costs else None,
        runs_without_cost=len(called) - len(costs),
        checklists=[
            ReportChecklist(checklist_id=key[0], version=key[1], conversations=count)
            for key, count in sorted(checklists.items())
        ],
        evaluators=report_evaluators,
        mock_used=any(item.get("provider") == MOCK_PROVIDER for item in used),
    )


def _load(conn: sqlite3.Connection, run_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM evaluation_runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise ApiError(404, "Оценка не найдена")
    if row["status"] != "done":
        raise ApiError(422, "Сбойный запуск нельзя сравнить, в нём нет результатов")
    return row


def _side(row: sqlite3.Row, score: dict[str, Any], final: dict[str, Any]) -> CompareSide:
    return CompareSide(
        id=row["id"],
        checklist_id=row["checklist_id"],
        checklist_version=row["checklist_version"],
        total=score["total"],
        final_total=final["total"],
        gross_error=score["gross_error"],
        final_gross_error=final["gross_error"],
        cache_hit=bool(json.loads(row["log_json"]).get("cache_hit")),
        created_at=row["created_at"],
    )


def _delta(first: float | None, second: float | None) -> float | None:
    return None if first is None or second is None else round(second - first, 2)


def compare_runs(db: Database, run_a: str, run_b: str) -> EvaluationCompare:
    with db.read() as conn:
        a, b = _load(conn, run_a), _load(conn, run_b)
    if a["conversation_id"] != b["conversation_id"]:
        raise ApiError(422, "Сравнить можно только запуски одного диалога")

    score_a, score_b = json.loads(a["score_json"]), json.loads(b["score_json"])
    final_a, final_b = json.loads(a["final_score_json"]), json.loads(b["final_score_json"])
    rubric_a = ChecklistVersion.model_validate_json(a["checklist_json"])
    rubric_b = ChecklistVersion.model_validate_json(b["checklist_json"])
    titles = {item.id: item.title for item in rubric_a.criteria}
    titles |= {item.id: item.title for item in rubric_b.criteria}  # the newer wording
    values_a = {item["criterion_id"]: CompareValue(**_value(item)) for item in score_a["criteria"]}
    values_b = {item["criterion_id"]: CompareValue(**_value(item)) for item in score_b["criteria"]}

    criteria = []
    for criterion_id, title in titles.items():
        first, second = values_a.get(criterion_id), values_b.get(criterion_id)
        answer_changed = (first and (first.status, first.answer)) != (
            second and (second.status, second.answer)
        )
        points_changed = (first and first.points) != (second and second.points)
        criteria.append(
            CompareCriterion(
                criterion_id=criterion_id,
                title=title,
                a=first,
                b=second,
                answer_changed=answer_changed,
                points_changed=points_changed,
                points_delta=_delta(first and first.points, second and second.points),
            )
        )
    return EvaluationCompare(
        conversation_id=a["conversation_id"],
        a=_side(a, score_a, final_a),
        b=_side(b, score_b, final_b),
        same_content=a["content_hash"] == b["content_hash"],
        same_rubric=a["checklist_hash"] == b["checklist_hash"],
        total_delta=_delta(score_a["total"], score_b["total"]),
        final_total_delta=_delta(final_a["total"], final_b["total"]),
        changed_criteria=[
            item.criterion_id for item in criteria if item.answer_changed or item.points_changed
        ],
        criteria=criteria,
    )


def _value(entry: dict[str, Any]) -> dict[str, Any]:
    keys = ("status", "answer", "weight", "effective_weight", "points")
    return {key: entry[key] for key in keys}
