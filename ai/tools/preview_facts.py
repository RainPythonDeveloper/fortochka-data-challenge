"""Print code-computed facts and hints for some DEV dialogues. Usage: python preview_facts.py <dev.json> <id>..."""
import json
import sys

from cqa_ai.annotate import annotate, render_facts, render_hints
from cqa_ai.service import snapshot_from_record

sys.stdout.reconfigure(encoding="utf-8")
records = {r["conversation_id"]: r for r in json.load(open(sys.argv[1], encoding="utf-8"))["data"]["records"]}
for cid in sys.argv[2:]:
    facts = annotate(snapshot_from_record(records[cid]))
    print("==", cid)
    print(render_facts(facts))
    print(render_hints(facts))
