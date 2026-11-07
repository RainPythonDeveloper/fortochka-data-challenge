import asyncio
import time

from conftest import CHECKLIST_ID, CountingEvaluator, make_record, new_version, put, run_job, wait_for_job


def set_weights(first: float, second: float):
    def change(body):
        by_id = {item["id"]: item for item in body["criteria"]}
        by_id["c01"]["weight"] = first
        by_id["c05"]["weight"] = second

    return change


def test_post_returns_the_job_immediately(make_client):
    release = None

    async def slow(snapshot, checklist, config):
        await release.wait()
        return await CountingEvaluator()(snapshot, checklist, config)

    client = make_client(evaluator=slow)
    put(client, "syn-001")
    release = asyncio.Event()
    job = client.post(
        "/evaluations", json={"conversation_ids": ["syn-001"], "checklist_id": CHECKLIST_ID}
    ).json()
    assert job["status"] in ("queued", "running") and job["total"] == 1 and job["done"] == 0
    client.portal.call(release.set)
    assert wait_for_job(client, job["id"])["status"] == "done"


def test_run_keeps_frozen_checklist_and_log(make_client):
    client = make_client(evaluator=CountingEvaluator())
    put(client, "syn-001")
    run_id = run_job(client, ["syn-001"])["evaluation_ids"][0]
    new_version(client, set_weights(50, 15))

    run = client.get(f"/evaluations/{run_id}").json()

    assert run["checklist"]["version"] == 1 and run["checklist_version"] == 1
    assert run["total"] == 90 and run["score"]["total"] == 90
    assert run["log"]["run_id"] == run_id and run["log"]["cache_hit"] is False
    assert len(run["log"]["content_hash"]) == 64 and len(run["log"]["attempts"]) == 1
    assert run["review_status"] == "flagged" and "mock_provider" in run["review_reasons"]
    with client.app.state.db.read() as conn:
        assert conn.execute("SELECT snapshot_json FROM evaluation_runs").fetchone()[0]


def test_cache_reuses_results_and_force_calls_the_model(make_client):
    evaluator = CountingEvaluator()
    client = make_client(evaluator=evaluator)
    put(client, "syn-001")

    first = run_job(client, ["syn-001"])["evaluation_ids"][0]
    second = run_job(client, ["syn-001"])["evaluation_ids"][0]
    assert len(evaluator.calls) == 1
    run = client.get(f"/evaluations/{second}").json()
    assert second != first
    assert run["log"]["cache_hit"] is True
    assert run["log"]["cached_from"] == first
    assert run["log"]["attempts"] == []
    assert run["results"] == client.get(f"/evaluations/{first}").json()["results"]

    forced = run_job(client, ["syn-001"], force=True)["evaluation_ids"][0]
    assert len(evaluator.calls) == 2
    assert client.get(f"/evaluations/{forced}").json()["log"]["cache_hit"] is False


def test_cache_misses_on_content_rubric_and_evaluator_change(make_client):
    evaluator = CountingEvaluator()
    client = make_client(evaluator=evaluator)
    put(client, "syn-001")
    run_job(client, ["syn-001"])

    changed = make_record()
    changed["transcript"][1]["text"] = "Другой текст"
    client.post("/transcripts", json=changed)
    run_job(client, ["syn-001"])
    assert len(evaluator.calls) == 2

    new_version(client, lambda body: body["criteria"][0].update(title="Новый смысл"))
    run_job(client, ["syn-001"])
    assert len(evaluator.calls) == 3

    other = make_client(evaluator=evaluator, llm_pipeline="ab")
    run_job(other, ["syn-001"])
    assert len(evaluator.calls) == 4


def test_cache_does_not_carry_manual_decisions(make_client):
    client = make_client(evaluator=CountingEvaluator())
    put(client, "syn-001")
    run_id = run_job(client, ["syn-001"])["evaluation_ids"][0]
    appeal = client.post(
        "/appeals", json={"evaluation_id": run_id, "criterion_id": "c01", "comment": "x"}
    ).json()
    client.post(
        f"/appeals/{appeal['id']}/decisions",
        json={"decision": "change", "new_answer": "yes", "reason": "r", "reviewer": "qa"},
    )
    cached = run_job(client, ["syn-001"])["evaluation_ids"][0]
    run = client.get(f"/evaluations/{cached}").json()
    assert run["log"]["cache_hit"] is True
    assert run["total"] == run["final_total"] == 90


def test_weight_only_change_recalculates_without_the_model(make_client):
    evaluator = CountingEvaluator()
    client = make_client(evaluator=evaluator)
    put(client, "syn-001")
    first = run_job(client, ["syn-001"])["evaluation_ids"][0]
    assert client.get(f"/evaluations/{first}").json()["total"] == 90

    version = new_version(client, set_weights(30, 15))
    second = run_job(client, ["syn-001"])["evaluation_ids"][0]

    assert len(evaluator.calls) == 1
    run = client.get(f"/evaluations/{second}").json()
    old = client.get(f"/evaluations/{first}").json()
    assert run["log"]["cache_hit"] is True
    assert run["log"]["checklist_hash"] == old["log"]["checklist_hash"]
    assert run["checklist_version"] == version["version"] == 2
    assert run["total"] == 75
    assert run["total"] != old["total"] and old["total"] == 90
    assert run["checklist"]["criteria"][0]["weight"] == 30


def test_one_failure_does_not_stop_the_batch_and_is_not_zero(make_client):
    evaluator = CountingEvaluator(fail_for={"syn-002"})
    client = make_client(evaluator=evaluator)
    put(client, "syn-001", "syn-002", "syn-003")

    job = run_job(client, ["syn-001", "syn-002", "syn-003", "syn-001"])

    assert job["status"] == "done"
    assert (job["total"], job["done"], job["failed"]) == (3, 2, 1)
    assert len(job["evaluation_ids"]) == 3
    assert job["errors"][0].startswith("syn-002: provider exploded")

    failed = client.get("/evaluations?conversation_id=syn-002").json()[0]
    assert failed["status"] == "failed"
    assert failed["total"] is None and failed["final_total"] is None and failed["error"]
    run = client.get(f"/evaluations/{failed['id']}").json()
    assert run["results"] == [] and run["score"]["total"] is None
    assert run["score"]["partial_total"] is None
    assert run["review_reasons"] == ["evaluation_failed"]
    summary = client.get("/conversations/syn-002").json()
    assert summary["latest_evaluation_id"] == failed["id"] and summary["latest_total"] is None
    assert client.get("/conversations/syn-001").json()["latest_total"] == 90


def test_failed_run_is_not_cached(make_client):
    evaluator = CountingEvaluator(fail_for={"syn-001"})
    client = make_client(evaluator=evaluator)
    put(client, "syn-001")
    assert run_job(client, ["syn-001"])["status"] == "failed"
    evaluator.fail_for = set()
    job = run_job(client, ["syn-001"])
    assert job["status"] == "done" and len(evaluator.calls) == 2


def test_scoring_error_from_a_bad_answer_is_a_failed_run(make_client):
    async def bad(snapshot, checklist, config):
        output = await CountingEvaluator()(snapshot, checklist, config)
        output.results[3].answer = 12
        return output

    client = make_client(evaluator=bad)
    put(client, "syn-001")
    job = run_job(client, ["syn-001"])
    assert job["status"] == "failed" and "scale level" in job["errors"][0]
    run = client.get(f"/evaluations/{job['evaluation_ids'][0]}").json()
    assert run["total"] is None and len(run["log"]["attempts"]) == 1


def test_no_provider_and_no_mock_fails_with_a_clear_message(make_client):
    client = make_client(cqa_allow_mock=False)
    put(client, "syn-001")
    job = run_job(client, ["syn-001"])
    assert job["status"] == "failed" and job["failed"] == 1
    assert "LLM_PROVIDER" in job["errors"][0] and "CQA_ALLOW_MOCK" in job["errors"][0]


def test_mock_works_only_with_the_flag(client):
    put(client, "syn-001")
    job = run_job(client, ["syn-001"])
    assert job["status"] == "done"
    run = client.get(f"/evaluations/{job['evaluation_ids'][0]}").json()
    assert run["results"][0]["review_flags"] == ["mock_provider"]
    assert run["log"]["evaluator"]["provider"] == "mock"


def test_real_provider_is_never_replaced_by_the_mock(make_client):
    client = make_client(llm_provider="openai", llm_model="some-model", cqa_allow_mock=True)
    put(client, "syn-001")
    job = run_job(client, ["syn-001"])
    assert job["status"] == "failed"
    assert "'openai' is not available" in job["errors"][0]
    assert client.get(f"/evaluations/{job['evaluation_ids'][0]}").json()["results"] == []


def test_provider_without_model_is_refused(make_client):
    client = make_client(llm_provider="openai", llm_model=None)
    put(client, "syn-001")
    job = run_job(client, ["syn-001"])
    assert job["status"] == "failed" and "LLM_MODEL" in job["errors"][0]


def test_concurrency_is_limited(make_client):
    state = {"now": 0, "peak": 0}

    async def tracked(snapshot, checklist, config):
        state["now"] += 1
        state["peak"] = max(state["peak"], state["now"])
        await asyncio.sleep(0.01)
        state["now"] -= 1
        return await CountingEvaluator()(snapshot, checklist, config)

    client = make_client(evaluator=tracked, cqa_eval_concurrency=2)
    ids = [f"syn-{index}" for index in range(6)]
    put(client, *ids)
    assert run_job(client, ids)["done"] == 6
    assert state["peak"] == 2


def test_timeout_is_a_failure(make_client):
    async def hang(*_):
        await asyncio.sleep(30)

    client = make_client(evaluator=hang, cqa_eval_timeout_s=0.02)
    put(client, "syn-001")
    job = run_job(client, ["syn-001"])
    assert job["status"] == "failed" and "время" in job["errors"][0]


def test_unfinished_job_resumes_after_restart(make_client):
    good = CountingEvaluator()

    async def stuck(snapshot, checklist, config):
        if snapshot.conversation_id == "syn-002":
            await asyncio.sleep(30)
        return await good(snapshot, checklist, config)

    first = make_client(evaluator=stuck, cqa_eval_concurrency=1)
    put(first, "syn-001", "syn-002")
    job_id = first.post(
        "/evaluations",
        json={"conversation_ids": ["syn-001", "syn-002"], "checklist_id": CHECKLIST_ID},
    ).json()["id"]
    for _ in range(500):
        if first.get(f"/jobs/{job_id}").json()["done"] == 1:
            break
        time.sleep(0.01)
    first.portal.call(first.app.state.service.shutdown)
    assert first.get(f"/jobs/{job_id}").json()["status"] == "running"

    second = make_client(evaluator=good)
    job = wait_for_job(second, job_id)

    assert job["status"] == "done" and job["done"] == 2
    assert good.calls == ["syn-001", "syn-002"]


def test_channel_outside_the_checklist_is_flagged(client):
    client.post("/transcripts", json=make_record("syn-v", channel="voice call"))
    run_id = run_job(client, ["syn-v"])["evaluation_ids"][0]
    run = client.get(f"/evaluations/{run_id}").json()
    assert "channel_not_in_checklist" in run["review_reasons"]
