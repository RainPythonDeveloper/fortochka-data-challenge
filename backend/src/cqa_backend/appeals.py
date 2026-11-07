"""Appeals and decisions. Only `final_results` and `final_score` ever change."""

from __future__ import annotations

import json
import sqlite3
import uuid

from cqa_ai import ScoringError, calculate_score
from cqa_ai.contracts import ChecklistVersion, CriterionResult, ResultStatus

from cqa_backend.db import Database, now_iso
from cqa_backend.errors import ApiError
from cqa_backend.schemas import Appeal, AppealCreate, Decision, DecisionCreate

DECISION_FLAG = "manual_decision"


def _appeal(row: sqlite3.Row) -> Appeal:
    decision = json.loads(row["decision_json"]) if row["decision_json"] else None
    return Appeal(
        id=row["id"],
        evaluation_id=row["evaluation_id"],
        criterion_id=row["criterion_id"],
        comment=row["comment"],
        status=row["status"],
        created_at=row["created_at"],
        decision=decision,
    )


def create_appeal(db: Database, body: AppealCreate) -> Appeal:
    appeal_id = str(uuid.uuid4())
    with db.tx() as conn:
        run = conn.execute(
            "SELECT status, checklist_json FROM evaluation_runs WHERE id = ?",
            (body.evaluation_id,),
        ).fetchone()
        if run is None:
            raise ApiError(404, "Оценка не найдена")
        if run["status"] != "done":
            raise ApiError(422, "Сбойный запуск нельзя оспорить, запустите оценку заново")
        checklist = ChecklistVersion.model_validate_json(run["checklist_json"])
        if body.criterion_id not in {item.id for item in checklist.criteria}:
            raise ApiError(422, "В рубрике этого запуска нет такого критерия")
        conn.execute(
            "INSERT INTO appeals VALUES (?, ?, ?, ?, 'open', NULL, ?)",
            (appeal_id, body.evaluation_id, body.criterion_id, body.comment, now_iso()),
        )
        row = conn.execute("SELECT * FROM appeals WHERE id = ?", (appeal_id,)).fetchone()
    return _appeal(row)


def list_appeals(
    db: Database, status: str | None = None, evaluation_id: str | None = None
) -> list[Appeal]:
    filters = {"status": status, "evaluation_id": evaluation_id}
    used = {key: value for key, value in filters.items() if value}
    clause = f"WHERE {' AND '.join(f'{key} = ?' for key in used)}" if used else ""
    with db.read() as conn:
        rows = conn.execute(
            f"SELECT * FROM appeals {clause} ORDER BY rowid DESC", list(used.values())
        ).fetchall()
    return [_appeal(row) for row in rows]


def _apply_change(
    conn: sqlite3.Connection, appeal: sqlite3.Row, body: DecisionCreate
) -> None:
    run = conn.execute(
        "SELECT checklist_json, final_results_json FROM evaluation_runs WHERE id = ?",
        (appeal["evaluation_id"],),
    ).fetchone()
    checklist = ChecklistVersion.model_validate_json(run["checklist_json"])
    results = [CriterionResult.model_validate(i) for i in json.loads(run["final_results_json"])]
    status = ResultStatus(body.new_status or ResultStatus.ASSESSED)
    if status is ResultStatus.NOT_APPLICABLE and body.new_answer is not None:
        raise ScoringError(f"{appeal['criterion_id']}: N/A cannot carry an answer")

    criterion_id = appeal["criterion_id"]
    previous = next((item for item in results if item.criterion_id == criterion_id), None)
    base = previous.model_dump() if previous else {"criterion_id": criterion_id}
    changed = CriterionResult.model_validate(
        {
            **base,
            "status": status,
            "answer": body.new_answer,
            "justification": body.reason,
            "review_flags": [*base.get("review_flags", []), DECISION_FLAG],
        }
    )
    final = [item for item in results if item.criterion_id != criterion_id] + [changed]
    order = {item.id: index for index, item in enumerate(checklist.criteria)}
    final.sort(key=lambda item: order.get(item.criterion_id, len(order)))
    score = calculate_score(checklist, final)  # raises ScoringError, the tx rolls back
    conn.execute(
        "UPDATE evaluation_runs SET final_results_json = ?, final_score_json = ? WHERE id = ?",
        (
            json.dumps([item.model_dump(mode="json") for item in final], ensure_ascii=False),
            score.model_dump_json(),
            appeal["evaluation_id"],
        ),
    )


def decide(db: Database, appeal_id: str, body: DecisionCreate) -> Appeal:
    with db.tx() as conn:
        appeal = conn.execute("SELECT * FROM appeals WHERE id = ?", (appeal_id,)).fetchone()
        if appeal is None:
            raise ApiError(404, "Апелляция не найдена")
        if appeal["status"] != "open":
            raise ApiError(409, "Решение по апелляции уже принято")
        if body.decision == "change":
            _apply_change(conn, appeal, body)
        elif body.new_answer is not None or body.new_status is not None:
            raise ApiError(422, "Решение confirm не меняет ответ")
        decision = Decision(**body.model_dump(), decided_at=now_iso())
        conn.execute(
            "UPDATE appeals SET status = 'decided', decision_json = ? WHERE id = ?",
            (decision.model_dump_json(), appeal_id),
        )
        row = conn.execute("SELECT * FROM appeals WHERE id = ?", (appeal_id,)).fetchone()
    return _appeal(row)
