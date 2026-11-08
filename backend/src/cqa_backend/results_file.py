"""Submission file in the organizers' format (results appendix, JSON format 1.0).

    results/dev/results.json   all DEV dialogues (60 chats and 5 calls)
    results/prod/results.json  the 10 control chats

One record per dialogue, built from the original automatic results (exports.collect),
never from decisions on appeals. Field names, criterion codes and value types follow
the appendix exactly:

- value: true = yes, false = no, null = N/A, a number = the scale level before weighting;
- evidence_turns: numbered from 1 over the original transcript array (ours count from 0);
- score.final_score: the checklist total; score.critical_flag equals the `critical` value;
- a dialogue that could not be scored: status "error", empty criteria, score null, error.

Voice calls are real and hold personal data, and this file goes to a public repository.
Their rationale is therefore the rubric rule that decided the answer, not the model's
own words, which may repeat what the client said.

Usage (from backend/):
    uv run python -m cqa_backend.results_file --group-id DEV --out ../results/dev/results.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from cqa_backend import exports
from cqa_backend.config import REPO_ROOT, Settings
from cqa_backend.db import Database

SCHEMA_VERSION = "1.0"
TEAM_NAME = "Форточка"
MODEL_MODE = "external_api"

# Checklist criterion id -> criterion code of the appendix, in the appendix order.
CRITERION_CODES = {
    "c01": "contact",
    "c02": "discovery",
    "c03": "identification",
    "c04": "consultation",
    "c05": "empathy",
    "c06": "dialogue",
    "c07": "closure",
    "c08": "critical",
}
_CHAT = "agent chat"
_ANSWER_TEXT = {True: "Да", False: "Нет", None: "Не применимо"}


def _value(entry: dict[str, Any]) -> bool | int | None:
    if entry["status"] != "assessed":
        return None
    answer = entry["answer"]
    if answer == "yes":
        return True
    if answer == "no":
        return False
    return int(answer)


def _turns(trace: dict[str, Any]) -> list[int]:
    """1-based turn numbers: the evidence, else where the missed action was expected,
    else the reviewed range."""
    found = {item["turn_index"] for item in trace.get("evidence") or [] if "turn_index" in item}
    if not found and trace.get("expected_at_turn") is not None:
        found = {trace["expected_at_turn"]}
    reviewed = trace.get("reviewed_range") or {}
    if not found and reviewed.get("from_turn") is not None:
        found = {reviewed["from_turn"], reviewed.get("to_turn", reviewed["from_turn"])}
    return sorted(index + 1 for index in found)


def _rationale(value: Any, trace: dict[str, Any], chat: bool) -> str:
    if chat and trace.get("justification"):
        return trace["justification"]
    label = _ANSWER_TEXT[value] if value is None or isinstance(value, bool) else str(value)
    rule = trace.get("rule_text") or trace.get("rule_ref") or "правило рубрики"
    return f"{label}: {rule}"


def _record(item: dict[str, Any], traces: dict[str, dict[str, Any]]) -> dict[str, Any]:
    by_id = {entry["criterion_id"]: entry for entry in item["criteria"]}
    usable = item["status"] == "done" and item["total"] is not None and all(
        criterion in by_id and by_id[criterion]["status"] in ("assessed", "not_applicable")
        for criterion in CRITERION_CODES
    )
    if not usable:
        reason = item["error"] or (
            "Диалог не оценён." if item["status"] == exports.NOT_EVALUATED
            else "Оценка неполная: не по всем критериям есть корректный ответ."
        )
        return {
            "conversation_id": item["conversation_id"],
            "status": "error",
            "criteria": [],
            "score": None,
            "error": reason,
        }
    chat = item["channel"] == _CHAT
    criteria = []
    for criterion, code in CRITERION_CODES.items():
        value = _value(by_id[criterion])
        trace = traces.get(criterion, {})
        criteria.append(
            {
                "criterion_id": code,
                "value": value,
                "rationale": _rationale(value, trace, chat),
                "evidence_turns": _turns(trace),
            }
        )
    critical = next(entry["value"] for entry in criteria if entry["criterion_id"] == "critical")
    return {
        "conversation_id": item["conversation_id"],
        "status": "ok",
        "criteria": criteria,
        "score": {"final_score": round(float(item["total"]), 2), "critical_flag": bool(critical)},
    }


def _run_details(db: Database, run_ids: list[str]) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """Per run: criterion id -> stored result. Plus every model that gave a valid answer."""
    if not run_ids:
        return {}, []
    marks = ",".join("?" * len(run_ids))
    with db.read() as conn:
        rows = conn.execute(
            f"SELECT id, results_json, log_json FROM evaluation_runs WHERE id IN ({marks})", run_ids
        ).fetchall()
    traces: dict[str, dict[str, Any]] = {}
    models: dict[str, None] = {}
    for row in rows:
        traces[row["id"]] = {
            result["criterion_id"]: result
            for result in json.loads(row["results_json"] or "[]")
            if isinstance(result, dict)
        }
        for attempt in json.loads(row["log_json"] or "{}").get("attempts", []):
            if attempt.get("valid") and attempt.get("model"):
                models[attempt["model"]] = None
    return traces, list(models)


def build(db: Database, group_id: str) -> dict[str, Any]:
    export = exports.collect(db, group_id, None)
    run_ids = [item["evaluation_id"] for item in export["results"] if item["evaluation_id"]]
    traces, models = _run_details(db, run_ids)
    return {
        "schema_version": SCHEMA_VERSION,
        "team_name": TEAM_NAME,
        "model": {"mode": MODEL_MODE, "name": ", ".join(models) or "не вызывалась"},
        "results": [_record(item, traces.get(item["evaluation_id"] or "", {})) for item in export["results"]],
    }


def check(data: dict[str, Any], expected: int | None = None) -> list[str]:
    """The appendix checklist before a push. Empty list: the file is fine."""
    problems = []
    ids = [item["conversation_id"] for item in data["results"]]
    if len(ids) != len(set(ids)):
        problems.append("повторяющиеся conversation_id")
    if expected is not None and len(ids) != expected:
        problems.append(f"записей {len(ids)}, ожидалось {expected}")
    for item in data["results"]:
        if item["status"] == "ok":
            codes = [entry["criterion_id"] for entry in item["criteria"]]
            if sorted(codes) != sorted(CRITERION_CODES.values()):
                problems.append(f"{item['conversation_id']}: не все 8 критериев")
            score = item["score"]["final_score"]
            if not 0 <= score <= 100:
                problems.append(f"{item['conversation_id']}: итог вне 0–100")
    return problems


def write(db: Database, group_id: str, path: Path) -> dict[str, Any]:
    data = build(db, group_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return data


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="results.json для сдачи организаторам")
    parser.add_argument("--group-id", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--expected-records", type=int, help="например 10 для контрольного набора")
    args = parser.parse_args(argv)
    load_dotenv(REPO_ROOT / ".env", override=False)
    data = write(Database(Settings().cqa_db_path), args.group_id, args.out)
    ok = sum(item["status"] == "ok" for item in data["results"])
    print(f"{args.out}: записей {len(data['results'])}, ok {ok}, error {len(data['results']) - ok}")
    problems = check(data, args.expected_records)
    for problem in problems:
        print(f"Проблема: {problem}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
