import httpx
from conftest import CHECKLIST_ID, CountingEvaluator, make_payload, make_record, new_version, put, run_job


def set_weight(value):
    def change(body):
        body["criteria"][0]["weight"] = value

    return change


def test_summary_counts_dialogues_by_language_and_channel(make_client):
    evaluator = CountingEvaluator(fail_for={"b"})
    records = [
        make_record("a"),
        make_record("b", language="KZ"),
        make_record("c", channel="voice call"),
    ]
    payload = make_payload(records)
    client = make_client(
        evaluator=evaluator,
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload)),
    )
    client.post("/imports", json={"group_id": "DEV"})
    put(client, "other")
    run_job(client, ["a", "b"])
    run_job(client, ["a"])

    report = client.get("/reports/summary?group_id=DEV").json()

    assert (report["conversations"], report["evaluated"], report["failed"]) == (3, 1, 1)
    assert report["not_evaluated"] == 1
    assert {item["key"]: item["failed"] for item in report["by_language"]} == {"KZ": 1, "RU": 0}
    channels = {item["key"]: item for item in report["by_channel"]}
    assert channels["voice call"]["not_evaluated"] == 1 and channels["agent chat"]["evaluated"] == 1
    assert (report["runs"], report["failed_runs"], report["cache_hits"]) == (3, 1, 1)
    assert report["checklists"] == [
        {"checklist_id": CHECKLIST_ID, "version": 1, "conversations": 2}
    ]
    assert report["evaluators"][0]["provider"] == "mock"
    assert report["mock_used"] is True
    assert report["avg_latency_ms"] is not None
    assert report["total_cost_usd"] is None and report["runs_without_cost"] == 2
    assert client.get("/reports/summary").json()["conversations"] == 4


def test_summary_sums_cost_without_cache_hits(make_client):
    async def priced(snapshot, checklist, config):
        output = await CountingEvaluator()(snapshot, checklist, config)
        output.attempts[0].cost_usd = 0.25
        return output

    client = make_client(evaluator=priced)
    put(client, "a")
    run_job(client, ["a"])
    run_job(client, ["a"], force=True)
    run_job(client, ["a"])
    report = client.get("/reports/summary").json()
    assert report["total_cost_usd"] == 0.5 and report["runs_without_cost"] == 0
    assert report["model_attempts"] == 2


def test_summary_of_an_empty_database(client):
    report = client.get("/reports/summary").json()
    assert report["conversations"] == 0 and report["by_channel"] == []
    assert report["avg_latency_ms"] is None and report["mock_used"] is False


def test_compare_weight_change_between_versions(make_client):
    client = make_client(evaluator=CountingEvaluator(c01="yes"))
    put(client, "a")
    first = run_job(client, ["a"])["evaluation_ids"][0]
    new_version(client, set_weight(30))
    second = run_job(client, ["a"])["evaluation_ids"][0]

    result = client.get(f"/evaluations/compare?a={first}&b={second}")

    assert result.status_code == 200, result.text
    body = result.json()
    assert body["conversation_id"] == "a"
    assert (body["a"]["checklist_version"], body["b"]["checklist_version"]) == (1, 2)
    assert body["b"]["cache_hit"] is True
    assert body["same_content"] is True and body["same_rubric"] is True
    c01 = next(item for item in body["criteria"] if item["criterion_id"] == "c01")
    assert c01["answer_changed"] is False and c01["a"]["weight"] == 10 and c01["b"]["weight"] == 30


def test_compare_shows_changed_answers_and_totals(make_client):
    evaluator = CountingEvaluator(c01="no")
    client = make_client(evaluator=evaluator)
    put(client, "a")
    first = run_job(client, ["a"])["evaluation_ids"][0]
    evaluator.c01 = "yes"
    new_version(client, lambda body: body["criteria"][0].update(title="Новая формулировка"))
    second = run_job(client, ["a"])["evaluation_ids"][0]

    body = client.get(f"/evaluations/compare?a={first}&b={second}").json()

    assert (body["a"]["total"], body["b"]["total"], body["total_delta"]) == (90, 100, 10)
    assert body["same_rubric"] is False
    assert "c01" in body["changed_criteria"]
    c01 = next(item for item in body["criteria"] if item["criterion_id"] == "c01")
    assert c01["title"] == "Новая формулировка"
    assert (c01["a"]["answer"], c01["b"]["answer"]) == ("no", "yes")
    assert c01["answer_changed"] is True and c01["points_delta"] > 0


def test_compare_uses_original_results_and_reports_final_separately(make_client):
    client = make_client(evaluator=CountingEvaluator())
    put(client, "a")
    first = run_job(client, ["a"])["evaluation_ids"][0]
    second = run_job(client, ["a"])["evaluation_ids"][0]
    appeal = client.post(
        "/appeals", json={"evaluation_id": second, "criterion_id": "c01", "comment": "x"}
    ).json()
    client.post(
        f"/appeals/{appeal['id']}/decisions",
        json={"decision": "change", "new_answer": "yes", "reason": "r", "reviewer": "qa"},
    )
    body = client.get(f"/evaluations/compare?a={first}&b={second}").json()
    assert body["total_delta"] == 0 and body["changed_criteria"] == []
    assert body["final_total_delta"] == 10


def test_compare_shows_a_criterion_present_in_one_version(make_client):
    client = make_client(evaluator=CountingEvaluator())
    put(client, "a")
    first = run_job(client, ["a"])["evaluation_ids"][0]

    def add(body):
        body["criteria"].append(
            {"id": "c99", "section": body["sections"][0]["id"], "title": "Новый",
             "type": "boolean", "weight": 5}
        )

    new_version(client, add)
    second = run_job(client, ["a"])["evaluation_ids"][0]
    body = client.get(f"/evaluations/compare?a={first}&b={second}").json()
    c99 = next(item for item in body["criteria"] if item["criterion_id"] == "c99")
    assert c99["a"] is None and c99["b"]["answer"] == "yes"
    assert c99["answer_changed"] is True and c99["points_delta"] is None


def test_compare_rejects_bad_pairs(make_client):
    client = make_client(evaluator=CountingEvaluator(fail_for={"bad"}))
    put(client, "a", "b", "bad")
    job = run_job(client, ["a", "b", "bad"])
    a, b, bad = job["evaluation_ids"]
    assert client.get(f"/evaluations/compare?a={a}&b={b}").status_code == 422
    assert client.get(f"/evaluations/compare?a={a}&b={bad}").status_code == 422
    assert client.get(f"/evaluations/compare?a={a}&b=none").status_code == 404
    assert client.get(f"/evaluations/compare?a={a}").status_code == 422
