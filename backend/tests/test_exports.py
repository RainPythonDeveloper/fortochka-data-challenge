import csv
import io

import httpx
from conftest import CountingEvaluator, make_payload, make_record, put, run_job


def imported(make_client, evaluator, ids, group_id="DEV"):
    payload = make_payload([make_record(item) for item in ids], group_id)
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json=payload))
    client = make_client(evaluator=evaluator, transport=transport)
    assert client.post("/imports", json={"group_id": group_id}).status_code == 200
    return client


def test_export_has_original_results_after_a_decision(make_client):
    client = imported(make_client, CountingEvaluator(), ["syn-001"])
    run_id = run_job(client, ["syn-001"])["evaluation_ids"][0]
    appeal = client.post(
        "/appeals", json={"evaluation_id": run_id, "criterion_id": "c01", "comment": "x"}
    ).json()
    client.post(
        f"/appeals/{appeal['id']}/decisions",
        json={"decision": "change", "new_answer": "yes", "reason": "r", "reviewer": "qa"},
    )
    assert client.get(f"/evaluations/{run_id}").json()["final_total"] == 100

    export = client.get("/exports/ai-results").json()

    item = export["results"][0]
    assert item["conversation_id"] == "syn-001" and item["total"] == 90
    assert item["gross_error"] is False
    c01 = next(entry for entry in item["criteria"] if entry["criterion_id"] == "c01")
    assert c01["answer"] == "no" and c01["points"] == 0

    table = client.get("/exports/ai-results?format=csv")
    assert table.headers["content-type"].startswith("text/csv")
    row = next(csv.DictReader(io.StringIO(table.text)))
    assert row["total"] == "90.0" and row["c01_answer"] == "no" and row["c01_points"] == "0.0"
    assert row["c04_answer"] == "20" and row["gross_error"] == "false"


def test_failures_and_unevaluated_dialogues_stay_visible_and_are_not_zero(make_client):
    evaluator = CountingEvaluator(fail_for={"syn-002"})
    client = imported(make_client, evaluator, ["syn-001", "syn-002", "syn-003"])
    run_job(client, ["syn-001", "syn-002"])

    export = client.get("/exports/ai-results").json()
    assert (export["total"], export["done"], export["failed"], export["not_evaluated"]) == (3, 1, 1, 1)
    failed = export["results"][1]
    assert failed["status"] == "failed" and failed["total"] is None
    assert "provider exploded" in failed["error"] and failed["criteria"] == []
    assert export["results"][2]["status"] == "not_evaluated"

    rows = list(csv.DictReader(io.StringIO(client.get("/exports/ai-results?format=csv").text)))
    assert [row["conversation_id"] for row in rows] == ["syn-001", "syn-002", "syn-003"]
    assert rows[1]["status"] == "failed" and rows[1]["total"] == "" and rows[1]["c01_points"] == ""
    assert "provider exploded" in rows[1]["error"]


def test_group_filter(make_client):
    client = imported(make_client, CountingEvaluator(), ["syn-001"], "DEV")
    put(client, "syn-other")
    run_job(client, ["syn-001", "syn-other"])

    assert client.get("/exports/ai-results").json()["total"] == 2
    filtered = client.get("/exports/ai-results?group_id=DEV").json()
    assert [item["conversation_id"] for item in filtered["results"]] == ["syn-001"]
    assert client.get("/exports/ai-results?group_id=NONE").json()["results"] == []
    assert client.get("/exports/ai-results?format=xml").status_code == 422


def test_csv_text_cannot_start_a_formula(make_client):
    client = make_client(evaluator=CountingEvaluator())
    client.post("/transcripts", json=make_record("=cmd"))
    text = client.get("/exports/ai-results?format=csv").text
    assert "'=cmd" in text
