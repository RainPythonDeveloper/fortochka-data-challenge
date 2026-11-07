"""All evaluated configurations on the `compare` split against the current reference.

Usage (from fortochka/ai): uv run python tools/compare_configs.py
"""

from __future__ import annotations

import glob
import json
import sys
from pathlib import Path

from cqa_ai import load_default_checklists
from cqa_ai.evaluation.bench import summarize

BENCH = Path(__file__).resolve().parents[2] / "data" / "bench"
CONFIGS = [
    ("Ultra single (прогон 1)", "s4-compare-A"),
    ("Ultra single (прогон 2)", "s7-ultra-repeat"),
    ("Super-VL + запасной Ultra", "s4-compare-B"),
    ("Два судьи Ultra+Super-VL, арбитр", "s4-compare-C"),
    ("sections: вызов на секцию", "s8-sections"),
    ("per_criterion: вызов на критерий", "s9-percrit"),
    ("vote: 3 прогона, большинство", "s10-vote"),
    ("second_opinion: Super-VL по c07,c08", "s11-second-opinion"),
    ("self_check: самопроверка", "s12-self-check"),
    ("facts_first: сначала факты", "s13-facts-first"),
]
COLS = ["dialogues", "failed", "all_acc", "c02_acc", "c04_acc", "c05_acc", "c06_acc", "c07_acc",
        "c08_acc", "MAE", "max_err", "p50_s", "p95_s", "calls_per_dialogue",
        "paid_equiv_usd_per_dialogue"]


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    labels_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("labels/reference_v3.json")
    ref = json.loads(labels_path.read_text(encoding="utf-8"))
    checklist = next(c for c in load_default_checklists() if c.checklist_id == ref["checklist_id"])
    print(f"Эталон: {labels_path.name}. Сплит compare, только чаты.\n")
    print("| Конфигурация | " + " | ".join(COLS) + " |")
    print("|---|" + "---|" * len(COLS))
    for title, folder in CONFIGS:
        files = glob.glob(str(BENCH / folder / "*" / "results.jsonl"))
        if not files:
            continue
        rows = [json.loads(x) for x in Path(files[0]).read_text(encoding="utf-8").splitlines() if x]
        rows = [r for r in rows if r["channel"] == "agent chat"]
        s = summarize(rows, ref["labels"], checklist)
        print(f"| {title} | " + " | ".join(str(s.get(c, "")) for c in COLS) + " |")


if __name__ == "__main__":
    main()
