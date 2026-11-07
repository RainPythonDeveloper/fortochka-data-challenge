"""Export of the original automatic results. Decisions on appeals are not included:
only `results_json` and `score_json` are read here.

Every conversation of the selection gets a row, so failed and not yet evaluated
dialogues stay visible. Their scores are empty, never zero.
"""

from __future__ import annotations

import csv
import io
import json
from typing import Any

from cqa_backend.db import Database, now_iso

NOT_EVALUATED = "not_evaluated"
_FIXED_COLUMNS = [
    "conversation_id", "group_id", "channel", "language", "status", "error", "evaluation_id",
    "checklist_id", "checklist_version", "total", "partial_total", "is_partial", "gross_error",
    "review_status", "review_reasons",
]


def _item(row: Any) -> dict[str, Any]:
    item: dict[str, Any] = {
        "conversation_id": row["id"],
        "group_id": row["group_id"],
        "channel": row["channel"],
        "language": row["language"],
        "status": row["status"] or NOT_EVALUATED,
        "error": row["error"],
        "evaluation_id": row["run_id"],
        "checklist_id": row["checklist_id"],
        "checklist_version": row["checklist_version"],
        "total": None,
        "partial_total": None,
        "is_partial": False,
        "gross_error": False,
        "review_status": row["review_status"],
        "review_reasons": json.loads(row["review_reasons_json"] or "[]"),
        "criteria": [],
    }
    if row["status"] == "done":
        score = json.loads(row["score_json"])
        item.update(
            total=score["total"],
            partial_total=score["partial_total"],
            is_partial=score["is_partial"],
            gross_error=score["gross_error"],
            criteria=[
                {
                    "criterion_id": entry["criterion_id"],
                    "status": entry["status"],
                    "answer": entry["answer"],
                    "weight": entry["weight"],
                    "points": entry["points"],
                }
                for entry in score["criteria"]
            ],
        )
    return item


def collect(db: Database, group_id: str | None, checklist_id: str | None) -> dict[str, Any]:
    latest = "SELECT MAX(rowid) FROM evaluation_runs WHERE conversation_id = c.id"
    params: list[str] = []
    if checklist_id:
        latest += " AND checklist_id = ?"
        params.append(checklist_id)
    query = f"""
        SELECT c.id, c.group_id, c.channel, c.language, r.id AS run_id, r.status, r.error,
               r.checklist_id, r.checklist_version, r.score_json, r.review_status,
               r.review_reasons_json
        FROM conversations c
        LEFT JOIN evaluation_runs r ON r.rowid = ({latest})
    """
    if group_id:
        query += " WHERE c.group_id = ?"
        params.append(group_id)
    with db.read() as conn:
        rows = conn.execute(f"{query} ORDER BY c.id", params).fetchall()
    results = [_item(row) for row in rows]
    return {
        "group_id": group_id,
        "generated_at": now_iso(),
        "total": len(results),
        "done": sum(item["status"] == "done" for item in results),
        "failed": sum(item["status"] == "failed" for item in results),
        "not_evaluated": sum(item["status"] == NOT_EVALUATED for item in results),
        "results": results,
    }


def _cell(value: Any) -> Any:
    """Empty stays empty. Text cannot start a spreadsheet formula."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@"):
        return f"'{value}"
    return value


def to_csv(export: dict[str, Any]) -> str:
    criterion_ids = list(
        dict.fromkeys(
            entry["criterion_id"] for item in export["results"] for entry in item["criteria"]
        )
    )
    columns = list(_FIXED_COLUMNS)
    for criterion_id in criterion_ids:
        columns += [f"{criterion_id}_status", f"{criterion_id}_answer", f"{criterion_id}_points"]

    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=columns)
    writer.writeheader()
    for item in export["results"]:
        row = {key: item[key] for key in _FIXED_COLUMNS}
        row["review_reasons"] = ";".join(item["review_reasons"])
        for entry in item["criteria"]:
            prefix = entry["criterion_id"]
            row[f"{prefix}_status"] = entry["status"]
            row[f"{prefix}_answer"] = entry["answer"]
            row[f"{prefix}_points"] = entry["points"]
        writer.writerow({key: _cell(value) for key, value in row.items()})
    return buffer.getvalue()
