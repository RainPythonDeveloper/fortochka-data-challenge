"""Import of transcripts and reads of stored conversations."""

from __future__ import annotations

import json
import logging
import sqlite3
from typing import Any
from urllib.parse import quote, urlsplit

import httpx
from cqa_ai import content_hash, snapshot_from_record
from cqa_ai.contracts import ConversationSnapshot
from pydantic import ValidationError

from cqa_backend.db import Database, now_iso
from cqa_backend.errors import ApiError
from cqa_backend.redact import redact
from cqa_backend.schemas import ConversationDetail, ConversationSummary, ImportResult

logger = logging.getLogger(__name__)

KNOWN_RECORD_FIELDS = {"conversation_id", "channel", "language", "transcript", "audio_url"}
KNOWN_TURN_FIELDS = {"timestamp", "speaker", "text"}
KNOWN_ROLES = {"client", "operator", "bot", "system"}
KNOWN_CHANNELS = {"agent chat", "voice call"}


class RecordError(ValueError):
    """A record breaks the schema. The message never contains record values."""


def _clip(value: object) -> str:
    return redact(value)[:64]


def check_record(record: Any) -> list[str]:
    """Raise RecordError for a broken record, return warnings for a usable one."""
    if not isinstance(record, dict):
        raise RecordError("запись не является объектом")
    for field in ("conversation_id", "channel", "language"):
        value = record.get(field)
        if not isinstance(value, str) or not value.strip():
            raise RecordError(f"поле {field} отсутствует или не является непустой строкой")
    audio_url = record.get("audio_url")
    if audio_url is not None and not isinstance(audio_url, str):
        raise RecordError("поле audio_url не является строкой")
    transcript = record.get("transcript")
    if not isinstance(transcript, list) or not transcript:
        raise RecordError("поле transcript отсутствует или пусто")

    fields = set(record) - KNOWN_RECORD_FIELDS
    turn_fields: set[str] = set()
    roles: set[str] = set()
    for index, turn in enumerate(transcript):
        if not isinstance(turn, dict):
            raise RecordError(f"реплика {index} не является объектом")
        if not isinstance(turn.get("speaker"), str) or not isinstance(turn.get("text"), str):
            raise RecordError(f"реплика {index}: speaker и text должны быть строками")
        if not isinstance(turn.get("timestamp"), (str, int, float)):
            raise RecordError(f"реплика {index}: нет метки времени")
        turn_fields |= set(turn) - KNOWN_TURN_FIELDS
        if turn["speaker"] not in KNOWN_ROLES:
            roles.add(turn["speaker"])

    warnings = []
    if fields:
        warnings.append(f"незнакомые поля записи: {_names(fields)}")
    if turn_fields:
        warnings.append(f"незнакомые поля реплик не сохранены: {_names(turn_fields)}")
    if roles:
        warnings.append(f"незнакомые роли: {_names(roles)}")
    if record["channel"] not in KNOWN_CHANNELS:
        warnings.append(f"незнакомый канал: {_clip(record['channel'])}")
    return warnings


def _names(values: set[str]) -> str:
    return ", ".join(_clip(value) for value in sorted(values))


def _store(conn: sqlite3.Connection, record: dict[str, Any], group_id: str | None) -> list[str]:
    """Upsert one record. Past runs keep their own snapshot, so they are not affected."""
    snapshot = snapshot_from_record(record)
    digest = content_hash(snapshot)
    existing = conn.execute(
        "SELECT content_hash, group_id FROM conversations WHERE id = ?",
        (snapshot.conversation_id,),
    ).fetchone()
    warnings = []
    if existing and existing["content_hash"] != digest:
        warnings.append("содержимое изменилось, прошлые запуски хранят свой снимок")
    if existing and group_id and existing["group_id"] not in (None, group_id):
        warnings.append(f"диалог перенесён из группы {_clip(existing['group_id'])}")
    conn.execute(
        """
        INSERT INTO conversations
            (id, channel, language, group_id, audio_url, turn_count, snapshot_json,
             content_hash, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
            channel = excluded.channel, language = excluded.language,
            group_id = COALESCE(excluded.group_id, conversations.group_id),
            audio_url = excluded.audio_url, turn_count = excluded.turn_count,
            snapshot_json = excluded.snapshot_json, content_hash = excluded.content_hash,
            imported_at = excluded.imported_at
        """,
        (
            snapshot.conversation_id,
            snapshot.channel,
            snapshot.language,
            group_id,
            snapshot.audio_url or None,
            len(snapshot.turns),
            snapshot.model_dump_json(exclude={"audio_url"}),
            digest,
            now_iso(),
        ),
    )
    return warnings


def fetch_payload(
    api_url: str | None,
    group_id: str,
    timeout_s: float,
    transport: httpx.BaseTransport | None = None,
) -> Any:
    if not api_url:
        raise ApiError(503, "CQA_API_URL не настроен")
    separator = "&" if "?" in api_url else "?"
    url = f"{api_url}{separator}group_id={quote(group_id, safe='')}"
    try:
        with httpx.Client(timeout=timeout_s, transport=transport) as client:
            response = client.get(url)
    except httpx.HTTPError as exc:
        # The exception text may quote the signed URL, only the type is reported.
        logger.warning("import request failed: %s", type(exc).__name__)
        raise ApiError(502, f"API организаторов недоступен: {type(exc).__name__}") from None
    if response.status_code != 200:
        raise ApiError(502, f"API организаторов вернул HTTP {response.status_code}")
    try:
        return json.loads(response.content)
    except ValueError:
        raise ApiError(502, "API организаторов вернул не JSON") from None


def ingest_payload(db: Database, payload: Any, group_id: str) -> ImportResult:
    if not isinstance(payload, dict):
        raise ApiError(502, "Ответ API не является объектом")
    if payload.get("isSuccess") is not True:
        raise ApiError(502, f"API вернул ошибку: {redact(payload.get('error') or 'isSuccess != true')}")
    data = payload.get("data")
    records = data.get("records") if isinstance(data, dict) else None
    if not isinstance(records, list):
        raise ApiError(502, "В ответе API нет списка data.records")

    errors: list[str] = []
    if data.get("total_records") != len(records):
        errors.append(
            f"warning: total_records={_clip(data.get('total_records'))}, "
            f"получено записей: {len(records)}"
        )
    dataset = data.get("dataset_group_id")
    if dataset is not None and dataset != group_id:
        errors.append(f"warning: запрошена группа {_clip(group_id)}, получена {_clip(dataset)}")

    seen: set[str] = set()
    imported: list[str] = []
    skipped = 0
    for position, record in enumerate(records):
        label = f"запись {position}"
        if isinstance(record, dict) and isinstance(record.get("conversation_id"), str):
            label = _clip(record["conversation_id"])
        try:
            warnings = check_record(record)
            if record["conversation_id"] in seen:
                raise RecordError("повторный conversation_id в ответе, оставлена первая запись")
            with db.tx() as conn:
                warnings += _store(conn, record, group_id)
        except (RecordError, ValidationError, KeyError, TypeError, AttributeError) as exc:
            skipped += 1
            detail = str(exc) if isinstance(exc, RecordError) else type(exc).__name__
            errors.append(f"{label}: {detail}")
            continue
        seen.add(record["conversation_id"])
        imported.append(record["conversation_id"])
        errors.extend(f"warning: {label}: {item}" for item in warnings)

    logger.info("import %s: imported=%d skipped=%d", group_id, len(imported), skipped)
    return ImportResult(
        group_id=group_id,
        imported=len(imported),
        skipped=skipped,
        conversation_ids=imported,
        errors=errors,
    )


def ingest_record(db: Database, record: Any) -> tuple[str, list[str]]:
    try:
        warnings = check_record(record)
        with db.tx() as conn:
            warnings += _store(conn, record, None)
    except RecordError as exc:
        raise ApiError(422, str(exc)) from None
    except (ValidationError, KeyError, TypeError, AttributeError) as exc:
        raise ApiError(422, f"Запись не прошла проверку: {type(exc).__name__}") from None
    return record["conversation_id"], warnings


_SUMMARY_SQL = """
SELECT c.*, r.id AS run_id, r.final_score_json, r.status AS run_status, r.error AS run_error,
    r.review_reasons_json AS run_reasons, r.review_status AS run_review_status,
    r.created_at AS run_created_at,
    (SELECT COUNT(*) FROM appeals a JOIN evaluation_runs e ON e.id = a.evaluation_id
     WHERE e.conversation_id = c.id AND a.status = 'open') AS open_appeals
FROM conversations c
LEFT JOIN evaluation_runs r ON r.rowid = (
    SELECT MAX(rowid) FROM evaluation_runs WHERE conversation_id = c.id
)
"""


def _summary(row: sqlite3.Row) -> dict[str, Any]:
    """`latest_*` show the current state, so they follow decisions on appeals."""
    score = json.loads(row["final_score_json"]) if row["final_score_json"] else {}
    return {
        "id": row["id"],
        "channel": row["channel"],
        "language": row["language"],
        "turn_count": row["turn_count"],
        "has_audio": bool(row["audio_url"]),
        "group_id": row["group_id"],
        "latest_evaluation_id": row["run_id"],
        "latest_total": score.get("total"),
        "gross_error": bool(score.get("gross_error")),
        "latest_status": row["run_status"],
        "latest_error": row["run_error"],
        "latest_reasons": json.loads(row["run_reasons"]) if row["run_reasons"] else [],
        "latest_evaluated_at": row["run_created_at"],
        "review_status": row["run_review_status"],
        "open_appeals": row["open_appeals"],
    }


def list_conversations(
    db: Database, channel: str | None, language: str | None
) -> list[ConversationSummary]:
    where, params = [], []
    if channel:
        where.append("c.channel = ? COLLATE NOCASE")
        params.append(channel)
    if language:
        where.append("c.language = ? COLLATE NOCASE")
        params.append(language)
    clause = f" WHERE {' AND '.join(where)}" if where else ""
    with db.read() as conn:
        rows = conn.execute(f"{_SUMMARY_SQL}{clause} ORDER BY c.id", params).fetchall()
    return [ConversationSummary(**_summary(row)) for row in rows]


def _row(db: Database, conversation_id: str) -> sqlite3.Row:
    with db.read() as conn:
        row = conn.execute(f"{_SUMMARY_SQL} WHERE c.id = ?", (conversation_id,)).fetchone()
    if row is None:
        raise ApiError(404, "Диалог не найден")
    return row


def get_summary(db: Database, conversation_id: str) -> dict[str, Any]:
    return _summary(_row(db, conversation_id))


def get_conversation(db: Database, conversation_id: str) -> ConversationDetail:
    row = _row(db, conversation_id)
    snapshot = ConversationSnapshot.model_validate_json(row["snapshot_json"])
    return ConversationDetail(**_summary(row), turns=snapshot.turns)


def get_audio_url(db: Database, conversation_id: str) -> str:
    url = _row(db, conversation_id)["audio_url"]
    if not url or urlsplit(url).scheme not in ("http", "https"):
        raise ApiError(404, "Записи для этого диалога нет")
    return url
