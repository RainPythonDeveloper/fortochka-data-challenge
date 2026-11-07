"""W3: the model × pipeline matrix and its leaderboard.

    uv run python -m cqa_ai.evaluation bench --data ../data/raw/dev.json --split tune \
        --models nvidia:google/gemma-4-31b-it,nvidia:nvidia/nemotron-3-ultra-550b-a55b \
        --pipelines single --repeats 1 --out ../data/bench/2026-11-07-a

Every combination writes its own `results.jsonl` and resumes like `run`. Different
combinations run in parallel; requests to one provider share its rate limiter.
At the end `leaderboard.md` and `leaderboard.csv` are written next to them.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any

from cqa_ai import load_default_checklists
from cqa_ai.contracts import ChecklistVersion, CriterionResult
from cqa_ai.evaluation.metrics import _value, compare, label_value
from cqa_ai.rubric import NA_ANSWER

SCALE_STEPS = {"c04": [0, 5, 10, 15, 20], "c06": [0, 4, 7, 10]}


def slug(model: str, pipeline: str, repeat: int) -> str:
    return f"{model.replace('/', '_').replace(':', '~')}__{pipeline}__r{repeat}"


def _pct(n: int, d: int) -> str:
    return f"{100 * n / d:.0f}%" if d else "—"


def _quantile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))
    return ordered[index]


def latest_rows(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One row per dialogue: a successful re-run replaces an earlier failed row."""
    latest: dict[str, dict[str, Any]] = {}
    for run in runs:
        if run["conversation_id"] not in latest or not run.get("failed"):
            latest[run["conversation_id"]] = run
    return list(latest.values())


def summarize(
    runs: list[dict[str, Any]], labels: dict[str, Any], checklist: ChecklistVersion
) -> dict[str, Any]:
    all_runs = latest_rows(runs)
    failed_ids = [r["conversation_id"] for r in all_runs if r.get("failed")]
    runs = [r for r in all_runs if not r.get("failed")]
    report = compare(runs, labels, checklist)
    row: dict[str, Any] = {
        "dialogues": len(runs),
        "failed": len(failed_ids),
        "labeled": report.labeled,
    }
    exact = compared = 0
    for cid, stats in sorted(report.criteria.items()):
        row[f"{cid}_acc"] = _pct(stats.exact, stats.compared)
        exact += stats.exact
        compared += stats.compared
    row["all_acc"] = _pct(exact, compared)
    row["MAE"] = report.mae
    row["max_err"] = max((e for e, _ in report.errors), default=None)

    # ±1 step on scales, false / missed N/A, gross-error misses and false alarms
    near = defaultdict(lambda: [0, 0])
    false_na = missed_na = 0
    for run in runs:
        label = labels.get(run["conversation_id"])
        if label is None:
            continue
        by_id = {
            r.criterion_id: r for r in (CriterionResult.model_validate(x) for x in run["results"])
        }
        for c in checklist.criteria:
            expected, actual = label_value(label[c.id]), _value(by_id.get(c.id))
            if actual is None:
                continue
            if actual == NA_ANSWER and expected != NA_ANSWER:
                false_na += 1
            if expected == NA_ANSWER and actual != NA_ANSWER:
                missed_na += 1
            steps = SCALE_STEPS.get(c.id)
            if steps and expected in steps and actual in steps:
                near[c.id][1] += 1
                if abs(steps.index(expected) - steps.index(actual)) <= 1:
                    near[c.id][0] += 1
    for cid, (ok, total) in near.items():
        row[f"{cid}_±1"] = _pct(ok, total)
    row["false_NA"] = false_na
    row["missed_NA"] = missed_na
    row["c08_missed"] = len(report.gross_missed)
    row["c08_false"] = len(report.gross_false)

    # reliability, speed, requests, price
    # Model time per dialogue: the sum of call latencies, without rate-limit queueing,
    # so parallel combos on one provider do not inflate each other's numbers.
    seconds = [sum((a.get("latency_ms") or 0) for a in r["attempts"]) / 1000 for r in runs]
    row["wall_p50_s"] = _quantile([r["seconds"] for r in runs], 0.5)
    attempts = [a for r in runs for a in r["attempts"]]

    def first_contract_valid(run: dict[str, Any]) -> bool:
        # Transport errors (429, timeouts) are not contract failures.
        answered = [a for a in run["attempts"] if a.get("input_tokens") is not None]
        return bool(answered) and bool(answered[0].get("valid"))

    first_valid = sum(1 for r in runs if first_contract_valid(r))
    row["valid_1st"] = _pct(first_valid, len(runs))
    row["repairs"] = sum(1 for r in runs if "contract_repair_used" in r.get("review_reasons", []))
    row["fallbacks"] = sum(
        1 for r in runs if "served_by_fallback_model" in r.get("review_reasons", [])
    )
    row["p50_s"] = _quantile(seconds, 0.5)
    row["p95_s"] = _quantile(seconds, 0.95)
    waits = [a.get("queue_wait_ms") or 0 for a in attempts]
    row["queue_ms_avg"] = round(statistics.mean(waits)) if waits else None
    n = max(len(runs), 1)
    row["calls_per_dialogue"] = round(len(attempts) / n, 2)
    row["tok_in_per_dialogue"] = round(sum(a.get("input_tokens") or 0 for a in attempts) / n)
    row["tok_out_per_dialogue"] = round(sum(a.get("output_tokens") or 0 for a in attempts) / n)
    row["cost_usd_per_dialogue"] = round(sum(a.get("cost_usd") or 0 for a in attempts) / n, 6)
    paid = [a.get("paid_equivalent_usd") for a in attempts]
    row["paid_equiv_usd_per_dialogue"] = (
        round(sum(p for p in paid if p) / n, 6) if any(p is not None for p in paid) else None
    )
    return row


def repeat_agreement(groups: list[list[dict[str, Any]]]) -> str:
    """Share of (dialogue, criterion) answers identical across all repeats."""
    if len(groups) < 2:
        return "—"
    groups = [[r for r in latest_rows(g) if not r.get("failed")] for g in groups]
    maps = [
        {(r["conversation_id"], x["criterion_id"]): _value(CriterionResult.model_validate(x))
         for r in g for x in r["results"]}
        for g in groups
    ]
    common = set.intersection(*(set(m) for m in maps))
    same = sum(1 for k in common if len({json.dumps(m[k]) for m in maps}) == 1)
    return _pct(same, len(common))


COLUMNS = [
    "model", "pipeline", "repeat", "dialogues", "failed", "all_acc",
    "c01_acc", "c02_acc", "c03_acc", "c04_acc", "c04_±1", "c05_acc", "c06_acc", "c06_±1",
    "c07_acc", "c08_acc", "MAE", "max_err", "false_NA", "missed_NA", "c08_missed", "c08_false",
    "valid_1st", "repairs", "fallbacks", "repeat_agree", "p50_s", "p95_s", "wall_p50_s", "queue_ms_avg",
    "calls_per_dialogue", "tok_in_per_dialogue", "tok_out_per_dialogue",
    "cost_usd_per_dialogue", "paid_equiv_usd_per_dialogue",
]


def write_leaderboard(out: Path, labels_path: Path) -> list[dict[str, Any]]:
    reference = json.loads(labels_path.read_text(encoding="utf-8"))
    checklist = next(
        c for c in load_default_checklists() if c.checklist_id == reference["checklist_id"]
    )
    by_combo: dict[tuple[str, str], list[tuple[int, list[dict]]]] = defaultdict(list)
    for meta_file in sorted(out.glob("*/combo.json")):
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        results = meta_file.parent / "results.jsonl"
        if not results.exists():
            continue
        runs = [json.loads(x) for x in results.read_text(encoding="utf-8").splitlines() if x]
        by_combo[(meta["model"], meta["pipeline"])].append((meta["repeat"], runs))

    rows = []
    for (model, pipeline), reps in sorted(by_combo.items()):
        agree = repeat_agreement([runs for _, runs in reps])
        for repeat, runs in sorted(reps):
            row = {"model": model, "pipeline": pipeline, "repeat": repeat}
            row.update(summarize(runs, reference["labels"], checklist))
            row["repeat_agree"] = agree
            rows.append(row)

    with (out / "leaderboard.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    lines = [
        f"# Leaderboard ({out.name})",
        "",
        f"Reference: `{labels_path.name}` ({reference['status']}). Not organizer Ground Truth.",
        "",
        "| " + " | ".join(COLUMNS) + " |",
        "|" + "---|" * len(COLUMNS),
    ]
    for row in rows:
        lines.append("| " + " | ".join(str(row.get(c, "")) for c in COLUMNS) + " |")
    (out / "leaderboard.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return rows


async def bench(args: argparse.Namespace, run_one) -> int:  # noqa: ANN001
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    pipelines = [p.strip() for p in args.pipelines.split(",") if p.strip()]
    jobs = []
    for model in models:
        for pipeline in pipelines:
            for repeat in range(1, args.repeats + 1):
                folder = out / slug(model, pipeline, repeat)
                folder.mkdir(parents=True, exist_ok=True)
                (folder / "combo.json").write_text(
                    json.dumps({"model": model, "pipeline": pipeline, "repeat": repeat}),
                    encoding="utf-8",
                )
                ns = argparse.Namespace(
                    data=args.data, split=args.split, channel=args.channel,
                    provider="nvidia", model=model,
                    fallback=getattr(args, "fallback", None),
                    no_fallback=not getattr(args, "fallback", None),
                    pipeline=pipeline, limit=args.limit, concurrency=args.concurrency,
                    pause=args.pause, out=str(folder),
                    second_model=getattr(args, "second_model", None),
                    arbiter_model=getattr(args, "arbiter_model", None),
                    second_criteria=getattr(args, "second_criteria", None),
                )
                jobs.append(run_one(ns))
    codes = await asyncio.gather(*jobs)
    stopped = sum(1 for code in codes if code)
    if stopped:
        print(f"Внимание: {stopped} комбинаций остановлены после серии сбоев, их цифры неполные.")
    rows = write_leaderboard(out, Path(args.labels))
    for row in rows:
        print(
            f"{row['model']:<50} {row['pipeline']:<8} r{row['repeat']} failed={row['failed']} "
            f"acc={row['all_acc']} MAE={row['MAE']} p50={row['p50_s']}s "
            f"calls={row['calls_per_dialogue']} paid≈${row['paid_equiv_usd_per_dialogue']}"
        )
    print(f"\n{out / 'leaderboard.md'}")
    return 0
