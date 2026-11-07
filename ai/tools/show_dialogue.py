"""Print DEV dialogues with turn indices. Usage: python -I show_dialogue.py <dev.json> <id> [<id> ...]

Reads only local data; never writes anything. Indices are 0-based positions in `transcript`.
"""
import json
import sys


def main() -> None:
    path, *ids = sys.argv[1:]
    records = {r["conversation_id"]: r for r in json.load(open(path, encoding="utf-8"))["data"]["records"]}
    if not ids:
        print("\n".join(sorted(records)))
        return
    for cid in ids:
        r = records[cid]
        print(f"===== {cid} | {r['channel']} | {r['language']} | turns={len(r['transcript'])}")
        for i, t in enumerate(r["transcript"]):
            print(f"#{i:<3} {t['timestamp']:>8} {t['speaker']:<9} {t['text']}")
        print()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
