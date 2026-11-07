"""Checklist versions. A version is never changed or deleted, an edit adds a new one."""

from __future__ import annotations

import logging
from typing import Any

from cqa_ai import load_default_checklists
from cqa_ai.contracts import ChecklistVersion
from pydantic import ValidationError

from cqa_backend.db import Database, now_iso
from cqa_backend.errors import ApiError, describe_validation
from cqa_backend.schemas import ChecklistSummary

logger = logging.getLogger(__name__)


def seed_defaults(db: Database) -> None:
    with db.tx() as conn:
        for checklist in load_default_checklists():
            cursor = conn.execute(
                "INSERT OR IGNORE INTO checklist_versions VALUES (?, ?, ?, ?)",
                (
                    checklist.checklist_id,
                    checklist.version,
                    checklist.model_dump_json(),
                    now_iso(),
                ),
            )
            if cursor.rowcount:
                logger.info("seeded checklist %s v%d", checklist.checklist_id, checklist.version)


def list_checklists(db: Database) -> list[ChecklistSummary]:
    with db.read() as conn:
        rows = conn.execute(
            """
            SELECT body_json FROM checklist_versions v
            WHERE version = (
                SELECT MAX(version) FROM checklist_versions WHERE checklist_id = v.checklist_id
            )
            ORDER BY checklist_id
            """
        ).fetchall()
    latest = [ChecklistVersion.model_validate_json(row["body_json"]) for row in rows]
    return [
        ChecklistSummary(
            checklist_id=item.checklist_id,
            title=item.title,
            latest_version=item.version,
            channels=item.channels,
        )
        for item in latest
    ]


def get_checklist(db: Database, checklist_id: str, version: int | None = None) -> ChecklistVersion:
    with db.read() as conn:
        if version is None:
            row = conn.execute(
                "SELECT body_json FROM checklist_versions WHERE checklist_id = ? "
                "ORDER BY version DESC LIMIT 1",
                (checklist_id,),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT body_json FROM checklist_versions WHERE checklist_id = ? AND version = ?",
                (checklist_id, version),
            ).fetchone()
    if row is None:
        raise ApiError(404, "Чек-лист или версия не найдены")
    return ChecklistVersion.model_validate_json(row["body_json"])


def create_version(db: Database, checklist_id: str, body: dict[str, Any]) -> ChecklistVersion:
    if body.get("checklist_id", checklist_id) != checklist_id:
        raise ApiError(422, "checklist_id в теле не совпадает с адресом")
    with db.tx() as conn:
        latest = conn.execute(
            "SELECT MAX(version) AS version FROM checklist_versions WHERE checklist_id = ?",
            (checklist_id,),
        ).fetchone()["version"]
        if latest is None:
            raise ApiError(404, "Чек-лист не найден")
        try:
            # `version` in the body is ignored, even when it is absent or invalid.
            checklist = ChecklistVersion.model_validate(
                {**body, "checklist_id": checklist_id, "version": latest + 1}
            )
        except ValidationError as exc:
            raise ApiError(422, describe_validation(exc)) from None
        conn.execute(
            "INSERT INTO checklist_versions VALUES (?, ?, ?, ?)",
            (checklist_id, checklist.version, checklist.model_dump_json(), now_iso()),
        )
    return checklist
