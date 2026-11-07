"""Runs the evaluator over a DEV split and compares it with the reference.

    uv run python -m cqa_ai.evaluation run --data <dev.json> --split tune
    uv run python -m cqa_ai.evaluation report --run <folder>

Finished dialogues are skipped on a repeated run, so an interrupted run resumes
without spending the free quota twice. Output holds real text, so it stays under
a `data/` folder, which Git ignores.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from importlib import resources
from pathlib import Path

from cqa_ai import (
    EvaluatorNotConfigured,
    evaluate,
    load_default_checklists,
    snapshot_from_record,
)
from cqa_ai.contracts import EvaluatorConfig, ResultStatus
from cqa_ai.evaluation.metrics import compare, render

DEFAULT_MODEL = "google/gemma-4-31b-it"
STOP_AFTER_FAILURES = 3


def _manifest() -> dict:
    path = resources.files("cqa_ai") / "evaluation" / "manifest.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _checklist_for(channel: str):
    return next(c for c in load_default_checklists() if channel in c.channels)


def _load_records(path: str) -> dict[str, dict]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    return {record["conversation_id"]: record for record in payload["data"]["records"]}


def _finished(out_file: Path) -> set[str]:
    if not out_file.exists():
        return set()
    # Failed dialogues are kept in the file for the report but retried on resume.
    rows = [json.loads(x) for x in out_file.read_text(encoding="utf-8").splitlines() if x.strip()]
    return {row["conversation_id"] for row in rows if not row.get("failed")}


async def _run(args: argparse.Namespace) -> int:
    records = _load_records(args.data)
    splits = _manifest()["splits"]
    wanted = (
        # "all" is tune + compare: the holdout is opened once, on purpose, by name.
        splits["tune"] + splits["compare"]
        if args.split == "all"
        else splits[args.split]
    )
    if args.channel:
        wanted = [cid for cid in wanted if records[cid]["channel"] == args.channel]
    if args.limit:
        wanted = wanted[: args.limit]

    slug = args.model.replace("/", "_").replace(":", "~")
    out_dir = Path(args.out or f"data/runs/{args.split}-{slug}")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "results.jsonl"
    done = _finished(out_file)
    todo = [cid for cid in wanted if cid not in done]
    print(f"Диалогов: {len(wanted)}, уже готово: {len(done & set(wanted))}, к оценке: {len(todo)}")

    fallback = None if getattr(args, "no_fallback", False) else (
        args.fallback or os.environ.get("LLM_FALLBACK_MODEL") or None
    )
    config = EvaluatorConfig(
        provider=args.provider,
        model=args.model,
        # "" keeps service.evaluate from filling the fallback in from the environment.
        fallback_model=fallback if fallback is not None else "",
        pipeline=getattr(args, "pipeline", "single"),
        max_output_tokens=int(os.environ.get("LLM_MAX_OUTPUT_TOKENS", "8000")),
        second_model=getattr(args, "second_model", None) or "",
        arbiter_model=getattr(args, "arbiter_model", None) or "",
        second_criteria=[
            x.strip() for x in (getattr(args, "second_criteria", None) or "").split(",") if x.strip()
        ],
    )
    failures = 0
    gate = asyncio.Semaphore(args.concurrency)
    lock = asyncio.Lock()

    async def one(conversation_id: str) -> None:
        nonlocal failures
        async with gate:
            if failures >= STOP_AFTER_FAILURES:
                return
            record = records[conversation_id]
            started = time.monotonic()
            output = await evaluate(
                snapshot_from_record(record), _checklist_for(record["channel"]), config
            )
            failed = all(r.status is ResultStatus.FAILED for r in output.results)
            async with lock:
                failures = failures + 1 if failed else 0
                # Failures are written too, so the leaderboard can count them.
                row = {
                    "failed": failed,
                    "conversation_id": conversation_id,
                    "language": record["language"],
                    "channel": record["channel"],
                    "model": config.model,
                    "seconds": round(time.monotonic() - started, 1),
                    **output.model_dump(mode="json"),
                }
                with out_file.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(row, ensure_ascii=False) + "\n")
                print(f"{conversation_id}: {'сбой' if failed else 'готово'}", flush=True)
            await asyncio.sleep(args.pause)

    await asyncio.gather(*(one(cid) for cid in todo))
    if failures >= STOP_AFTER_FAILURES:
        print(f"Остановлено: {STOP_AFTER_FAILURES} сбоя подряд, квоту не тратим.")
        return 1
    print(f"Результаты: {out_file}")
    return 0


def _report(args: argparse.Namespace) -> int:
    path = Path(args.run) / "results.jsonl"
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
    from cqa_ai.evaluation.bench import latest_rows

    runs = latest_rows(rows)
    failed = [r["conversation_id"] for r in runs if r.get("failed")]
    runs = [r for r in runs if not r.get("failed")]
    if failed:
        print(f"Не оценены (сбой): {', '.join(failed)}")
    reference = json.loads(Path(args.labels).read_text(encoding="utf-8"))
    checklist = next(
        c for c in load_default_checklists() if c.checklist_id == reference["checklist_id"]
    )
    print(f"Разметка: {reference['status']}")
    print(render(compare(runs, reference["labels"], checklist)))
    seconds = [run["seconds"] for run in runs]
    attempts = sum(len(run["attempts"]) for run in runs)
    if seconds:
        print(f"\nСреднее время: {sum(seconds) / len(seconds):.1f} с, вызовов модели: {attempts}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="cqa_ai.evaluation")
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run")
    run.add_argument("--data", required=True)
    run.add_argument("--split", choices=["tune", "compare", "holdout"], default="tune")
    run.add_argument("--channel", default="agent chat", help="пустая строка: все каналы")
    run.add_argument("--provider", default="nvidia")
    run.add_argument("--model", default=DEFAULT_MODEL)
    run.add_argument("--fallback")
    run.add_argument("--limit", type=int)
    run.add_argument("--concurrency", type=int, default=3)
    run.add_argument("--pause", type=float, default=2.0)
    run.add_argument("--out")
    report = commands.add_parser("report")
    report.add_argument("--run", required=True)
    report.add_argument("--labels", default="labels/reference_v3.json")
    bench_cmd = commands.add_parser("bench")
    bench_cmd.add_argument("--data", required=True)
    bench_cmd.add_argument("--split", choices=["tune", "compare", "holdout", "all"], default="tune")
    bench_cmd.add_argument("--channel", default="agent chat", help="пустая строка: все каналы")
    bench_cmd.add_argument("--models", required=True, help="provider:model через запятую")
    bench_cmd.add_argument("--pipelines", default="single")
    bench_cmd.add_argument("--repeats", type=int, default=1)
    bench_cmd.add_argument("--limit", type=int)
    bench_cmd.add_argument("--concurrency", type=int, default=3)
    bench_cmd.add_argument("--pause", type=float, default=1.0)
    bench_cmd.add_argument("--out", required=True)
    bench_cmd.add_argument("--labels", default="labels/reference_v3.json")
    bench_cmd.add_argument("--second-model", dest="second_model", help="для two_judges")
    bench_cmd.add_argument("--fallback", help="запасная модель; по умолчанию без неё")
    bench_cmd.add_argument("--arbiter-model", dest="arbiter_model", help="для two_judges")
    bench_cmd.add_argument("--second-criteria", dest="second_criteria", help="для second_opinion: c07,c08")
    board = commands.add_parser("leaderboard", help="пересобрать таблицу по готовым прогонам")
    board.add_argument("--out", required=True)
    board.add_argument("--labels", default="labels/reference_v3.json")
    args = parser.parse_args()
    if args.command == "report":
        return _report(args)
    if args.command == "leaderboard":
        from cqa_ai.evaluation.bench import write_leaderboard

        write_leaderboard(Path(args.out), Path(args.labels))
        print(Path(args.out) / "leaderboard.md")
        return 0
    if args.command == "bench":
        from cqa_ai.evaluation.bench import bench

        try:
            return asyncio.run(bench(args, _run))
        except EvaluatorNotConfigured as error:
            print(error, file=sys.stderr)
            return 2
    try:
        return asyncio.run(_run(args))
    except EvaluatorNotConfigured as error:
        print(error, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
