"""Control run for the last hour: `uv run python -m cqa_backend.control --group-id X`.

Import with strict checks, one preset evaluator, retries of incomplete dialogues only,
a completeness check, JSON and CSV exports outside Git and a short console report.
Exit code 0 means every expected dialogue has a complete automatic result.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from cqa_ai import EvaluatorNotConfigured
from dotenv import load_dotenv

from cqa_backend import checklists, conversations, exports
from cqa_backend.app import build_service
from cqa_backend.config import MOCK_PROVIDER, REPO_ROOT, Settings, resolve_evaluator_config
from cqa_backend.db import Database
from cqa_backend.errors import ApiError
from cqa_backend.evaluations import EvaluationService, Evaluator
from cqa_backend.redact import redact
from cqa_backend.schemas import EvaluationRequest

ERROR_PREVIEW = 120


class ControlError(Exception):
    """The run stopped before results could be trusted."""


@dataclass
class ControlOptions:
    group_id: str
    expected_records: int = 10
    checklist_id: str | None = None
    checklists_by_channel: dict[str, str] | None = None
    max_retries: int = 2
    retry_delay_s: float = 30
    out_dir: Path | None = None
    force: bool = False
    allow_mock: bool = False


@dataclass
class ControlReport:
    group_id: str
    evaluator: str
    conversation_ids: list[str]
    complete: list[str] = field(default_factory=list)
    incomplete: dict[str, str] = field(default_factory=dict)
    rounds: int = 0
    runs: int = 0
    cache_hits: int = 0
    cost_usd: float | None = None
    runs_without_cost: int = 0
    checklists: list[str] = field(default_factory=list)
    seconds: float = 0
    warnings: list[str] = field(default_factory=list)
    json_path: Path | None = None
    csv_path: Path | None = None

    @property
    def ok(self) -> bool:
        return not self.incomplete and len(self.complete) == len(self.conversation_ids)


def check_payload(payload: Any, group_id: str, expected: int) -> list[str]:
    """Stop on anything that makes the control set unreliable, before it is stored."""
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(payload, dict) or payload.get("isSuccess") is not True:
        raise ControlError("API не подтвердил успех запроса")
    records = data.get("records") if isinstance(data, dict) else None
    if not isinstance(records, list):
        raise ControlError("В ответе нет data.records")
    problems = []
    if len(records) != expected:
        problems.append(f"записей {len(records)}, ожидалось {expected}")
    if data.get("total_records") != len(records):
        problems.append("total_records не совпадает с числом записей")
    dataset = data.get("dataset_group_id")
    if dataset is not None and dataset != group_id:
        problems.append("dataset_group_id не совпадает с запрошенной группой")

    warnings: list[str] = []
    seen: set[str] = set()
    for position, record in enumerate(records):
        try:
            found = conversations.check_record(record)
        except conversations.RecordError as exc:
            problems.append(f"запись {position}: {exc}")
            continue
        if record["conversation_id"] in seen:
            problems.append(f"запись {position}: повторный conversation_id")
        seen.add(record["conversation_id"])
        warnings.extend(f"{redact(record['conversation_id'])[:64]}: {item}" for item in found)
    if problems:
        raise ControlError("; ".join(problems))
    return warnings


def find_incomplete(db: Database, conversation_ids: list[str]) -> dict[str, str]:
    """Every dialogue needs a done run with no missing criterion. Reads the latest run."""
    incomplete: dict[str, str] = {}
    with db.read() as conn:
        for conversation_id in conversation_ids:
            row = conn.execute(
                "SELECT status, error, score_json, checklist_json FROM evaluation_runs "
                "WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1",
                (conversation_id,),
            ).fetchone()
            if row is None:
                incomplete[conversation_id] = "нет запуска"
                continue
            if row["status"] != "done":
                incomplete[conversation_id] = row["error"] or "сбой"
                continue
            score = json.loads(row["score_json"])
            rubric = json.loads(row["checklist_json"])
            if score["is_partial"]:
                missing = ", ".join(score["missing_criteria"])
                incomplete[conversation_id] = f"нет результата по критериям: {missing}"
            elif len(score["criteria"]) != len(rubric["criteria"]):
                incomplete[conversation_id] = "число критериев не совпадает с рубрикой"
    return incomplete


def default_out_dir(group_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", group_id) or "group"
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return REPO_ROOT / "data" / "control" / f"{safe}-{stamp}"


def check_outside_git(path: Path) -> None:
    """`git check-ignore` exits with 1 for a path that Git would track."""
    probe = path.resolve()
    parent = next((item for item in (probe, *probe.parents) if item.exists()), None)
    result = subprocess.run(
        ["git", "-C", str(parent), "check-ignore", "-q", str(probe)],
        capture_output=True,
        check=False,
    )
    if result.returncode == 1:
        raise ControlError(f"Папка экспорта попадёт в Git: {probe}")


def write_exports(db: Database, options: ControlOptions, out_dir: Path) -> tuple[Path, Path]:
    export = exports.collect(db, options.group_id, options.checklist_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path, csv_path = out_dir / "ai-results.json", out_dir / "ai-results.csv"
    json_path.write_text(json.dumps(export, ensure_ascii=False, indent=2), encoding="utf-8")
    csv_path.write_text(exports.to_csv(export), encoding="utf-8")
    return json_path, csv_path


def _collect_usage(service: EvaluationService, report: ControlReport, job_ids: list[str]) -> None:
    run_ids = [item for job in job_ids for item in service.get_job(job).evaluation_ids]
    runs = [service.get_run(run_id) for run_id in run_ids]
    logs = [run.log for run in runs]
    report.checklists = sorted(
        {f"{run.checklist_id} v{run.checklist_version}" for run in runs if run.checklist_id}
    )
    called = [log for log in logs if log.attempts]
    costs = [log.cost_usd for log in called if log.cost_usd is not None]
    report.runs = len(logs)
    report.cache_hits = sum(log.cache_hit for log in logs)
    report.cost_usd = round(sum(costs), 6) if costs else None
    report.runs_without_cost = len(called) - len(costs)


async def run_control(
    settings: Settings,
    options: ControlOptions,
    evaluator: Evaluator | None = None,
    transport: httpx.BaseTransport | None = None,
) -> ControlReport:
    started = time.perf_counter()
    config = resolve_evaluator_config(settings)
    if config.provider == MOCK_PROVIDER and not options.allow_mock:
        raise ControlError("Контрольный прогон на заглушке требует флага --allow-mock")
    out_dir = options.out_dir or default_out_dir(options.group_id)
    check_outside_git(out_dir)

    db, service = build_service(settings, evaluator)
    checklists.seed_defaults(db)

    payload = conversations.fetch_payload(
        settings.cqa_api_url, options.group_id, settings.cqa_http_timeout_s, transport
    )
    warnings = check_payload(payload, options.group_id, options.expected_records)
    imported = conversations.ingest_payload(db, payload, options.group_id)
    if imported.skipped:
        raise ControlError(f"Импорт пропустил записей: {imported.skipped}")

    report = ControlReport(
        group_id=options.group_id,
        evaluator=f"{config.provider}/{config.model}/{config.pipeline}",
        conversation_ids=imported.conversation_ids,
        warnings=warnings,
    )
    pending = imported.conversation_ids
    job_ids: list[str] = []
    for attempt in range(options.max_retries + 1):
        if attempt:
            await asyncio.sleep(options.retry_delay_s)
        job = service.create_job(
            EvaluationRequest(
                conversation_ids=pending,
                checklist_id=options.checklist_id,
                checklists_by_channel=options.checklists_by_channel,
                force=options.force and attempt == 0,
            )
        )
        job_ids.append(job.id)
        await service.wait()
        report.rounds = attempt + 1
        report.incomplete = find_incomplete(db, imported.conversation_ids)
        pending = list(report.incomplete)
        if not pending:
            break

    report.complete = [
        item for item in imported.conversation_ids if item not in report.incomplete
    ]
    report.json_path, report.csv_path = write_exports(db, options, out_dir)
    _collect_usage(service, report, job_ids)
    report.seconds = round(time.perf_counter() - started, 1)
    return report


def format_report(report: ControlReport) -> str:
    cost = "неизвестна" if report.cost_usd is None else f"${report.cost_usd:.4f}"
    if report.runs_without_cost and report.cost_usd is not None:
        cost += f" (без учёта {report.runs_without_cost} запусков)"
    lines = [
        f"Группа: {report.group_id}",
        f"Оценщик: {report.evaluator}",
        f"Чек-листы: {', '.join(report.checklists) or 'нет'}",
        f"Оценено полностью: {len(report.complete)} из {len(report.conversation_ids)}",
        f"Сбоев и неполных: {len(report.incomplete)}",
        f"Раундов: {report.rounds}, запусков: {report.runs}, из кэша: {report.cache_hits}",
        f"Время: {report.seconds} с",
        f"Стоимость: {cost}",
        f"JSON: {report.json_path}",
        f"CSV: {report.csv_path}",
    ]
    lines += [f"Предупреждение: {item}" for item in report.warnings]
    lines += [
        f"Не готово: {key}: {redact(value)[:ERROR_PREVIEW]}"
        for key, value in report.incomplete.items()
    ]
    lines.append("ГОТОВО" if report.ok else "НЕ ГОТОВО: результат неполный")
    return "\n".join(lines)


def parse_args(argv: list[str] | None = None) -> ControlOptions:
    parser = argparse.ArgumentParser(description="Контрольный прогон CQA")
    parser.add_argument("--group-id", required=True)
    parser.add_argument("--expected-records", type=int, default=10)
    parser.add_argument("--checklist-id", help="по умолчанию чек-лист выбирается по каналу")
    parser.add_argument(
        "--checklist-for",
        action="append",
        metavar="КАНАЛ=ID",
        help="чек-лист для канала, можно повторять: --checklist-for 'voice call=<id>'",
    )
    parser.add_argument("--max-retries", type=int, default=2)
    parser.add_argument("--retry-delay", type=float, default=30, dest="retry_delay_s")
    parser.add_argument("--out-dir", type=Path, help="по умолчанию data/control/<группа>-<время>")
    parser.add_argument("--force", action="store_true", help="не брать результаты из кэша")
    parser.add_argument("--allow-mock", action="store_true", help="разрешить заглушку")
    values = vars(parser.parse_args(argv))
    pairs = values.pop("checklist_for") or []
    if pairs and values["checklist_id"]:
        parser.error("--checklist-for нельзя сочетать с --checklist-id")
    assigned: dict[str, str] = {}
    for pair in pairs:
        channel, separator, checklist_id = pair.partition("=")
        if not separator or not channel.strip() or not checklist_id.strip():
            parser.error(f"--checklist-for ждёт КАНАЛ=ID, получено {pair!r}")
        assigned[channel.strip()] = checklist_id.strip()
    return ControlOptions(**values, checklists_by_channel=assigned or None)


def main(argv: list[str] | None = None) -> int:
    options = parse_args(argv)
    load_dotenv(REPO_ROOT / ".env", override=False)
    try:
        report = asyncio.run(run_control(Settings(), options))
    except Exception as exc:  # noqa: BLE001 - the operator needs one masked line
        known = isinstance(exc, (ControlError, ApiError, EvaluatorNotConfigured))
        reason = redact(exc) if known else type(exc).__name__
        print(f"ОСТАНОВЛЕНО: {reason}", file=sys.stderr)
        return 2
    print(format_report(report))
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
