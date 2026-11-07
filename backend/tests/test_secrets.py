import json
import logging
import sys

import httpx
from conftest import (
    AUDIO_URL,
    CHECKLIST_ID,
    SIG_PARAM,
    CountingEvaluator,
    make_payload,
    make_record,
    run_job,
)

from cqa_backend.app import build_service
from cqa_backend.redact import RedactingFilter, redact


def test_audio_url_is_absent_from_every_response(make_client):
    payload = make_payload([make_record("syn-v", channel="voice call", audio_url=AUDIO_URL)])
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json=payload))
    client = make_client(transport=transport)

    bodies = [client.post("/imports", json={"group_id": "DEV"}).text]
    bodies.append(client.post("/transcripts", json=make_record("syn-w", audio_url=AUDIO_URL)).text)
    job = run_job(client, ["syn-v"])
    run_id = job["evaluation_ids"][0]
    appeal = client.post(
        "/appeals", json={"evaluation_id": run_id, "criterion_id": "c01", "comment": "x"}
    )
    for path in (
        "/conversations",
        "/conversations/syn-v",
        f"/jobs/{job['id']}",
        "/evaluations",
        f"/evaluations/{run_id}",
        "/appeals",
        "/exports/ai-results",
        "/exports/ai-results?format=csv",
    ):
        bodies.append(client.get(path).text)
    bodies.append(appeal.text)

    for body in bodies:
        assert "audio_url" not in body
        assert "AUDIOSIGNATURE123" not in body
    summary = client.get("/conversations/syn-v").json()
    assert summary["has_audio"] is True


def test_audio_route_redirects_or_returns_404(client):
    client.post("/transcripts", json=make_record("syn-v", audio_url=AUDIO_URL))
    client.post("/transcripts", json=make_record("syn-c"))
    client.post("/transcripts", json=make_record("syn-x", audio_url="javascript:alert(1)"))

    response = client.get("/conversations/syn-v/audio", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"] == AUDIO_URL
    assert client.get("/conversations/syn-c/audio").status_code == 404
    assert client.get("/conversations/syn-x/audio").status_code == 404
    assert client.get("/conversations/none/audio").status_code == 404


def test_audio_url_is_not_stored_in_run_snapshots(client):
    client.post("/transcripts", json=make_record("syn-v", audio_url=AUDIO_URL))
    run_job(client, ["syn-v"])
    with client.app.state.db.read() as conn:
        row = conn.execute("SELECT snapshot_json FROM evaluation_runs").fetchone()
    assert "AUDIOSIGNATURE123" not in row["snapshot_json"]


def test_evaluator_error_with_a_url_is_masked(make_client, caplog):
    caplog.set_level(logging.DEBUG)
    client = make_client(evaluator=CountingEvaluator(fail_for={"syn-001"}))
    client.post("/transcripts", json=make_record())

    job = run_job(client, ["syn-001"])

    assert "AUDIOSIGNATURE123" not in json.dumps(job)
    assert "provider exploded" in job["errors"][0]
    assert "AUDIOSIGNATURE123" not in client.get(f"/evaluations/{job['evaluation_ids'][0]}").text
    assert "AUDIOSIGNATURE123" not in caplog.text


def test_dialogue_text_does_not_reach_logs(make_client, caplog):
    caplog.set_level(logging.DEBUG)
    client = make_client()
    client.post("/transcripts", json=make_record())
    run_job(client, ["syn-001"])
    assert "Вопрос про тариф" not in caplog.text


def test_nvidia_key_is_masked_in_errors_and_logs(settings, monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "plain-looking-provider-key")
    build_service(settings)
    assert redact("401 for key plain-looking-provider-key") == "401 for key [masked]"
    assert redact("nvapi-Abc123_def456") == "[masked]"


def test_redact_masks_urls_and_bare_signatures():
    assert "AUDIOSIGNATURE123" not in redact(f"failed: {AUDIO_URL} (x)")
    assert redact(f"a {SIG_PARAM}=abc&x=1") == "a [masked]&x=1"
    assert redact("plain text") == "plain text"


def test_log_filter_masks_message_args_and_traceback():
    try:
        raise RuntimeError(AUDIO_URL)
    except RuntimeError:
        record = logging.LogRecord(
            "x", logging.ERROR, __file__, 1, "got %s %d", (AUDIO_URL, 5), sys.exc_info()
        )
    RedactingFilter().filter(record)
    line = logging.Formatter("%(message)s").format(record)
    assert "AUDIOSIGNATURE123" not in line
    assert "got [masked] 5" in line


def test_log_filter_keeps_format_strings_that_look_like_urls():
    record = logging.LogRecord(
        "x", logging.INFO, __file__, 1, "running on %s://%s:%d", ("http", "127.0.0.1", 80), None
    )
    RedactingFilter().filter(record)
    assert record.getMessage() == "running on http://127.0.0.1:80"


def test_unexpected_error_is_generic_and_keeps_the_format(make_client):
    client = make_client()

    def boom(*_args):
        raise RuntimeError(AUDIO_URL)

    client.app.state.service.list_runs = boom
    response = client.get("/evaluations")
    assert response.status_code == 500
    assert isinstance(response.json()["detail"], str)
    assert "AUDIOSIGNATURE123" not in response.text


def test_errors_use_a_string_detail_and_cors_allows_vite(client):
    bad = client.post("/evaluations", json={"conversation_ids": []})
    assert bad.status_code == 422 and isinstance(bad.json()["detail"], str)
    missing = client.post(
        "/evaluations", json={"conversation_ids": ["none"], "checklist_id": CHECKLIST_ID}
    )
    assert missing.status_code == 404 and "none" in missing.json()["detail"]
    assert client.get("/health").json() == {"status": "ok"}
    allowed = client.get("/health", headers={"Origin": "http://localhost:5173"})
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
    denied = client.get("/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in denied.headers
