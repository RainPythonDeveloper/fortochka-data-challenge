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
    return {
        json.loads(line)["conversation_id"]
        for line in out_file.read_text(encoding="utf-8").splitlines()
        if line.strip()
    }


async def _run(args: argparse.Namespace) -> int:
    records = _load_records(args.data)
    wanted = _manifest()["splits"][args.split]
    if args.channel:
        wanted = [cid for cid in wanted if records[cid]["channel"] == args.channel]
    if args.limit:
        wanted = wanted[: args.limit]

    out_dir = Path(args.out or f"data/runs/{args.split}-{args.model.replace('/', '_')}")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "results.jsonl"
    done = _finished(out_file)
    todo = [cid for cid in wanted if cid not in done]
    print(f"Диалогов: {len(wanted)}, уже готово: {len(done & set(wanted))}, к оценке: {len(todo)}")

    config = EvaluatorConfig(
        provider=args.provider,
        model=args.model,
        fallback_model=args.fallback or os.environ.get("LLM_FALLBACK_MODEL") or None,
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
                if not failed:
                    row = {
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
    runs = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
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
    report.add_argument("--labels", default="labels/reference_v1.json")
    args = parser.parse_args()
    if args.command == "report":
        return _report(args)
    try:
        return asyncio.run(_run(args))
    except EvaluatorNotConfigured as error:
        print(error, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
