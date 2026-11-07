import sqlite3

import pytest
from conftest import CountingEvaluator, put, run_job


@pytest.fixture
def scored(make_client):
    client = make_client(evaluator=CountingEvaluator())
    put(client, "syn-001")
    return client, run_job(client, ["syn-001"])["evaluation_ids"][0]


def appeal(client, run_id, criterion_id="c01"):
    response = client.post(
        "/appeals",
        json={"evaluation_id": run_id, "criterion_id": criterion_id, "comment": "Не согласен"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def decide(client, appeal_id, **body):
    payload = {"decision": "change", "reason": "Причина", "reviewer": "qa", **body}
    return client.post(f"/appeals/{appeal_id}/decisions", json=payload)


def test_full_flow_on_the_mock(make_client):
    client = make_client(evaluator=CountingEvaluator())
    put(client, "syn-001")
    run_id = run_job(client, ["syn-001"])["evaluation_ids"][0]
    before = client.get(f"/evaluations/{run_id}").json()
    assert before["total"] == before["final_total"] == 90

    created = appeal(client, run_id)
    assert created["status"] == "open" and created["decision"] is None
    assert [item["id"] for item in client.get("/appeals?status=open").json()] == [created["id"]]

    decided = decide(client, created["id"], new_answer="yes")
    assert decided.status_code == 200
    body = decided.json()
    assert body["status"] == "decided" and body["decision"]["new_answer"] == "yes"
    assert body["decision"]["decided_at"]
    assert client.get("/appeals?status=open").json() == []

    after = client.get(f"/evaluations/{run_id}").json()
    assert after["final_total"] == 100 and after["final_score"]["total"] == 100
    assert after["results"] == before["results"]
    assert after["score"] == before["score"] and after["total"] == 90
    final = next(item for item in after["final_results"] if item["criterion_id"] == "c01")
    assert final["answer"] == "yes" and final["justification"] == "Причина"
    assert "manual_decision" in final["review_flags"]
    assert [item["criterion_id"] for item in after["final_results"]] == [
        item["criterion_id"] for item in before["results"]
    ]
    assert client.get("/conversations/syn-001").json()["latest_total"] == 100


def test_several_appeals_accumulate_on_one_run(scored):
    client, run_id = scored
    first, second = appeal(client, run_id, "c01"), appeal(client, run_id, "c07")
    assert decide(client, first["id"], new_answer="yes").status_code == 200
    assert decide(client, second["id"], new_status="not_applicable").status_code == 200

    run = client.get(f"/evaluations/{run_id}").json()
    by_id = {item["criterion_id"]: item for item in run["final_results"]}
    assert by_id["c01"]["answer"] == "yes"
    assert by_id["c07"]["status"] == "not_applicable" and by_id["c07"]["answer"] is None
    assert run["final_total"] == 100 and run["total"] == 90


def test_confirm_keeps_the_final_result(scored):
    client, run_id = scored
    created = appeal(client, run_id)
    response = decide(client, created["id"], decision="confirm")
    assert response.status_code == 200 and response.json()["status"] == "decided"
    assert client.get(f"/evaluations/{run_id}").json()["final_total"] == 90

    other = appeal(client, run_id)
    assert decide(client, other["id"], decision="confirm", new_answer="yes").status_code == 422


@pytest.mark.parametrize(
    ("criterion_id", "body"),
    [
        ("c04", {"new_answer": 12}),  # not a level of the scale
        ("c04", {"new_answer": "yes"}),
        ("c04", {"new_answer": True}),
        ("c01", {"new_answer": 5}),
        ("c01", {}),
        ("c01", {"new_status": "not_applicable"}),  # N/A is not allowed for c01
        ("c02", {"new_status": "not_applicable", "new_answer": "yes"}),
        ("c01", {"new_answer": "yes", "new_status": "unassessable"}),
    ],
)
def test_change_breaking_the_rubric_is_rejected(scored, criterion_id, body):
    client, run_id = scored
    created = appeal(client, run_id, criterion_id)
    response = decide(client, created["id"], **body)
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)
    run = client.get(f"/evaluations/{run_id}").json()
    assert run["final_results"] == run["results"]
    assert client.get("/appeals?status=open").json()[0]["id"] == created["id"]


def test_gross_error_flag_follows_the_decision_but_not_the_score(scored):
    client, run_id = scored
    created = appeal(client, run_id, "c08")
    assert decide(client, created["id"], new_answer="yes").status_code == 200
    run = client.get(f"/evaluations/{run_id}").json()
    assert run["final_score"]["gross_error"] is True and run["gross_error"] is True
    assert run["score"]["gross_error"] is False
    assert run["final_total"] == 90


def test_appeal_validation(scored):
    client, run_id = scored
    body = {"evaluation_id": run_id, "criterion_id": "c01", "comment": "x"}
    assert client.post("/appeals", json={**body, "evaluation_id": "none"}).status_code == 404
    assert client.post("/appeals", json={**body, "criterion_id": "zz"}).status_code == 422
    assert client.post("/appeals", json={**body, "comment": "  "}).status_code == 422
    assert client.post("/appeals/none/decisions", json={
        "decision": "confirm", "reason": "r", "reviewer": "q"
    }).status_code == 404

    created = appeal(client, run_id)
    assert decide(client, created["id"], new_answer="yes", reason=" ").status_code == 422
    assert decide(client, created["id"], new_answer="yes").status_code == 200
    assert decide(client, created["id"], new_answer="no").status_code == 409


def test_failed_run_cannot_be_appealed(make_client):
    client = make_client(evaluator=CountingEvaluator(fail_for={"syn-001"}))
    put(client, "syn-001")
    run_id = run_job(client, ["syn-001"])["evaluation_ids"][0]
    response = client.post(
        "/appeals", json={"evaluation_id": run_id, "criterion_id": "c01", "comment": "x"}
    )
    assert response.status_code == 422


def test_source_results_are_protected_by_the_database(scored):
    client, _ = scored
    with client.app.state.db.read() as conn:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("UPDATE evaluation_runs SET results_json = '[]'")
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("UPDATE evaluation_runs SET score_json = '{}'")
