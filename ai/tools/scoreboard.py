"""Scoreboard of the frozen configuration: chats vs calls, accuracy, speed, cost.

Usage (from fortochka/ai): uv run python tools/scoreboard.py > ../docs/SCOREBOARD_DATA.md

Reads bench results and reference labels only; prints metrics, never transcript text.
"""

from __future__ import annotations

import glob
import json
import statistics
import sys
from pathlib import Path

from cqa_ai import load_default_checklists
from cqa_ai.evaluation.bench import latest_rows, summarize

BENCH = Path(__file__).resolve().parents[2] / "data" / "bench"
ULTRA = "nvidia~nvidia_nemotron-3-ultra-550b-a55b__single__r1"

GROUPS = [
    ("Чаты · holdout (не видели при настройке)", ["HOLDOUT-clean"], "agent chat"),
    ("Чаты · compare, прогон 1", ["s4-compare-A"], "agent chat"),
    ("Чаты · compare, прогон 2", ["s7-ultra-repeat"], "agent chat"),
    ("Чаты · tune", ["s3-tune-v3"], "agent chat"),
    ("Звонки · tune + compare", ["s16-calls-v2"], "voice call"),
    ("Звонки · holdout", ["HOLDOUT-call"], "voice call"),
    ("Звонки · все 5", ["s16-calls-v2", "HOLDOUT-call"], "voice call"),
]

COLUMNS = [
    ("dialogues", "Диалогов"), ("failed", "Сбоев"), ("all_acc", "Совпадение"),
    ("c01_acc", "c01"), ("c02_acc", "c02"), ("c03_acc", "c03"), ("c04_acc", "c04"),
    ("c05_acc", "c05"), ("c06_acc", "c06"), ("c07_acc", "c07"), ("c08_acc", "c08"),
    ("c04_±1", "c04 ±1"), ("c06_±1", "c06 ±1"), ("MAE", "MAE итога"), ("max_err", "Макс. ошибка"),
    ("c08_missed", "c08 пропущено"), ("c08_false", "c08 ложно"),
    ("false_NA", "Ложное N/A"), ("missed_NA", "Пропущ. N/A"),
    ("valid_1st", "JSON с 1-го раза"), ("repairs", "Починок"), ("fallbacks", "Запасная модель"),
    ("p50_s", "p50, с"), ("p95_s", "p95, с"), ("calls_per_dialogue", "Вызовов/диалог"),
    ("tok_in_per_dialogue", "Токенов вход"), ("tok_out_per_dialogue", "Токенов выход"),
    ("cost_usd_per_dialogue", "Цена, $"), ("paid_equiv_usd_per_dialogue", "Платный экв., $/диалог"),
]


def rows_for(folders: list[str], channel: str) -> list[dict]:
    rows: list[dict] = []
    for folder in folders:
        for path in glob.glob(str(BENCH / folder / ULTRA / "results.jsonl")):
            rows += [json.loads(x) for x in Path(path).read_text(encoding="utf-8").splitlines() if x]
    return [r for r in latest_rows(rows) if r["channel"] == channel]


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ref = json.loads(Path("labels/reference_v3.json").read_text(encoding="utf-8"))
    checklist = next(c for c in load_default_checklists() if c.checklist_id == ref["checklist_id"])
    table = []
    for title, folders, channel in GROUPS:
        rows = rows_for(folders, channel)
        if not rows:
            continue
        s = summarize(rows, ref["labels"], checklist)
        paid = s.get("paid_equiv_usd_per_dialogue")
        s["paid10"] = round(paid * 10, 3) if paid else None
        table.append((title, s))
    keys = [k for k, _ in COLUMNS] + ["paid10"]
    names = [n for _, n in COLUMNS] + ["Платный экв., $/10 диалогов"]
    print("| Метрика | " + " | ".join(t for t, _ in table) + " |")
    print("|---|" + "---|" * len(table))
    for key, name in zip(keys, names):
        print(f"| {name} | " + " | ".join(str(s.get(key, "")) for _, s in table) + " |")


if __name__ == "__main__":
    main()
