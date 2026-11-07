"""Merge annotator files into ai/labels/reference_v2.json and report agreement with v1.

Usage: python -I merge_labels.py <labels_work_dir> <reference_v1.json> <out_v2.json>
"""
import json
import sys
from collections import Counter
from pathlib import Path

CRITERIA = [f"c0{i}" for i in range(1, 9)]
ALLOWED = {
    "c01": {"yes", "no"}, "c05": {"yes", "no"}, "c08": {"yes", "no"},
    "c02": {"yes", "no", "na"}, "c03": {"yes", "no", "na"}, "c07": {"yes", "no", "na"},
    "c04": {20, 15, 10, 5, 0, "na"}, "c06": {10, 7, 4, 0},
}


def main() -> None:
    work, v1_path, out = map(Path, sys.argv[1:4])
    merged, low = {}, []
    for f in sorted(work.glob("A*.json")):
        for cid, row in json.loads(f.read_text(encoding="utf-8")).items():
            entry = {}
            for c in CRITERIA:
                cell = row[c]
                assert cell["v"] in ALLOWED[c], (cid, c, cell["v"])
                entry[c] = {"v": cell["v"], "turn": cell.get("turn"), "why": cell.get("why", "")}
            for c, level in (row.get("_conf") or {}).items():
                low.append((cid, c, entry[c]["v"]))
            if row.get("_notes"):
                entry["_notes"] = row["_notes"]
            merged[cid] = entry
    assert len(merged) == 65, len(merged)
    doc = {
        "version": 2,
        "status": "independent_llm_annotators_v2_needs_adjudication",
        "note": "Proxy reference, not organizer Ground Truth. Four independent annotators, "
        "organizer rulings on c01/c02/c03+c08/c07 applied. Used only for measurement, never at runtime.",
        "checklist_id": "freedom-chat-quality",
        "low_confidence": [f"{cid}:{c}" for cid, c, _ in low],
        "labels": dict(sorted(merged.items())),
    }
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {out} with {len(merged)} dialogues, {len(low)} low-confidence cells")

    v1 = json.loads(v1_path.read_text(encoding="utf-8"))["labels"]
    agree, total, diffs = Counter(), Counter(), []
    for cid, row in v1.items():
        for c in CRITERIA:
            total[c] += 1
            new = merged[cid][c]["v"]
            if row[c] == new:
                agree[c] += 1
            else:
                diffs.append(f"{cid} {c}: v1={row[c]} v2={new}")
    print(f"\nAgreement v1 (draft) vs v2 on {len(v1)} dialogues:")
    for c in CRITERIA:
        print(f"  {c}: {agree[c]}/{total[c]}")
    print(f"  all: {sum(agree.values())}/{sum(total.values())}")
    print("\nDifferences:\n  " + "\n  ".join(diffs))
    dist = {c: Counter(str(merged[k][c]["v"]) for k in merged) for c in CRITERIA}
    print("\nValue distribution v2:")
    for c in CRITERIA:
        print(f"  {c}: {dict(dist[c])}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
