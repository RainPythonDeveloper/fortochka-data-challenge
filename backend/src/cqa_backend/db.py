"""SQLite storage. A connection per operation keeps it safe across threads and
transactions short. Immutability of source data is enforced by triggers as well."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    language TEXT NOT NULL,
    group_id TEXT,
    audio_url TEXT,
    turn_count INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checklist_versions (
    checklist_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    body_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (checklist_id, version)
);
CREATE TRIGGER IF NOT EXISTS checklist_no_update BEFORE UPDATE ON checklist_versions
BEGIN SELECT RAISE(ABORT, 'checklist versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS checklist_no_delete BEFORE DELETE ON checklist_versions
BEGIN SELECT RAISE(ABORT, 'checklist versions cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    checklist_id TEXT NOT NULL,
    checklist_version INTEGER NOT NULL,
    force INTEGER NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_items (
    job_id TEXT NOT NULL REFERENCES jobs(id),
    position INTEGER NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    status TEXT NOT NULL,
    evaluation_id TEXT,
    error TEXT,
    checklist_id TEXT,
    checklist_version INTEGER,
    PRIMARY KEY (job_id, position)
);

CREATE TABLE IF NOT EXISTS evaluation_runs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    checklist_id TEXT NOT NULL,
    checklist_version INTEGER NOT NULL,
    checklist_json TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    results_json TEXT NOT NULL,
    score_json TEXT NOT NULL,
    final_results_json TEXT NOT NULL,
    final_score_json TEXT NOT NULL,
    review_status TEXT NOT NULL,
    review_reasons_json TEXT NOT NULL,
    log_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    checklist_hash TEXT NOT NULL,
    evaluator_key TEXT,
    cacheable INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_by_conversation ON evaluation_runs (conversation_id);
CREATE INDEX IF NOT EXISTS runs_by_cache_key
    ON evaluation_runs (content_hash, checklist_hash, evaluator_key);
CREATE TRIGGER IF NOT EXISTS runs_source_immutable
BEFORE UPDATE OF results_json, score_json, checklist_json, snapshot_json ON evaluation_runs
BEGIN SELECT RAISE(ABORT, 'automatic results are immutable'); END;

CREATE TABLE IF NOT EXISTS appeals (
    id TEXT PRIMARY KEY,
    evaluation_id TEXT NOT NULL REFERENCES evaluation_runs(id),
    criterion_id TEXT NOT NULL,
    comment TEXT NOT NULL,
    status TEXT NOT NULL,
    decision_json TEXT,
    created_at TEXT NOT NULL
);
"""


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


class Database:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.read() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(SCHEMA)
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(job_items)")}
            for name, kind in (("checklist_id", "TEXT"), ("checklist_version", "INTEGER")):
                if name not in columns:  # a database from before per-dialogue checklists
                    conn.execute(f"ALTER TABLE job_items ADD COLUMN {name} {kind}")

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self.read() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            conn.execute("COMMIT")
