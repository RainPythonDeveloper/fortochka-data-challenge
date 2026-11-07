import json
import time

from conftest import CHECKLIST_ID, CountingEvaluator, make_record, new_version, put, run_job, wait_for_job

from cqa_backend.config import Settings


def add_voice_checklist(client):
    body = client.get(f"/checklists/{CHECKLIST_ID}").json()
    voice = {**body, "checklist_id": "any-voice-name", "channels": ["voice call"], "version": 1}
    with client.app.state.db.tx() as conn:
        conn.execute(
            "INSERT INTO checklist_versions VALUES ('any-voice-name', 1, ?, 'now')",
            (json.dumps(voice),),
        )


def auto_job(client, ids, **extra):
    response = client.post("/evaluations", json={"conversation_ids": ids, **extra})
    assert response.status_code == 200, response.text
    return wait_for_job(client, response.json()["id"])


def test_checklist_is_chosen_by_channel_without_knowing_its_name(client):
    add_voice_checklist(client)
    put(client, "syn-chat")
    client.post("/transcripts", json=make_record("syn-call", channel="voice call"))

    job = auto_job(client, ["syn-chat", "syn-call"])

    assert job["status"] == "done" and job["done"] == 2
    runs = {item["conversation_id"]: item for item in client.get("/evaluations").json()}
    assert runs["syn-chat"]["checklist_id"] == CHECKLIST_ID
    assert runs["syn-call"]["checklist_id"] == "any-voice-name"
    run = client.get(f"/evaluations/{runs['syn-call']['id']}").json()
    assert "channel_not_in_checklist" not in run["review_reasons"]


def test_latest_version_is_used_and_fixed_for_the_run(client):
    put(client, "syn-001")
    new_version(client, lambda body: body.update(title="Вторая версия"))
    auto_job(client, ["syn-001"])
    assert client.get("/evaluations").json()[0]["checklist_version"] == 2


def test_explicit_checklist_works_as_before(client):
    client.post("/transcripts", json=make_record("syn-call", channel="voice call"))
    job = run_job(client, ["syn-call"], version=1)
    assert job["status"] == "done"
    assert client.get("/evaluations").json()[0]["checklist_id"] == CHECKLIST_ID


def test_channel_without_a_checklist_fails_alone_and_stays_visible(client):
    put(client, "syn-chat")
    client.post("/transcripts", json=make_record("syn-call", channel="voice call"))

    job = auto_job(client, ["syn-chat", "syn-call"])

    assert job["status"] == "done" and (job["done"], job["failed"]) == (1, 1)
    assert "voice call" in job["errors"][0]
    failed = client.get("/evaluations?conversation_id=syn-call").json()[0]
    assert failed["status"] == "failed" and failed["total"] is None
    run = client.get(f"/evaluations/{failed['id']}").json()
    assert run["checklist"] is None and run["results"] == []
    export = client.get("/exports/ai-results").json()
    assert export["failed"] == 1
    assert client.get("/exports/ai-results?format=csv").status_code == 200


def test_version_needs_a_checklist_id(client):
    put(client, "syn-001")
    response = client.post("/evaluations", json={"conversation_ids": ["syn-001"], "version": 1})
    assert response.status_code == 422


def test_defaults_suit_rate_limited_cloud_apis():
    settings = Settings(_env_file=None)
    assert settings.cqa_eval_concurrency == 3 and settings.cqa_eval_pause_s == 3


def test_pause_spaces_model_calls_but_not_cache_hits(make_client):
    starts = []
    inner = CountingEvaluator()

    async def timed(snapshot, checklist, config):
        starts.append(time.monotonic())
        return await inner(snapshot, checklist, config)

    client = make_client(evaluator=timed, cqa_eval_concurrency=3, cqa_eval_pause_s=0.05)
    put(client, "a", "b", "c")
    run_job(client, ["a", "b", "c"])
    gaps = [second - first for first, second in zip(starts, starts[1:])]
    assert len(starts) == 3 and min(gaps) >= 0.045

    began = time.monotonic()
    run_job(client, ["a", "b", "c"])
    assert len(starts) == 3 and time.monotonic() - began < 1


def test_job_from_an_old_database_still_resumes(make_client):
    good = CountingEvaluator()
    client = make_client(evaluator=good)
    put(client, "syn-001")
    with client.app.state.db.tx() as conn:
        conn.execute(
            "INSERT INTO jobs VALUES ('old', 'running', ?, 1, 0, NULL, 'now')", (CHECKLIST_ID,)
        )
        conn.execute(
            "INSERT INTO job_items (job_id, position, conversation_id, status) "
            "VALUES ('old', 0, 'syn-001', 'pending')"
        )
    second = make_client(evaluator=good)
    assert wait_for_job(second, "old")["status"] == "done"
