import json
import logging

import httpx
from conftest import API_URL, AUDIO_URL, make_payload, make_record


def transport_for(payload, seen=None):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(str(request.url))
        return httpx.Response(200, content=json.dumps(payload).encode("utf-8"))

    return httpx.MockTransport(handler)


def test_import_uses_group_id_and_keeps_text_and_repeats(make_client):
    seen = []
    records = [make_record("syn-002"), make_record("syn-001")]
    client = make_client(transport=transport_for(make_payload(records, "CTRL 1"), seen))

    result = client.post("/imports", json={"group_id": "CTRL 1"}).json()

    assert seen == [f"{API_URL}&group_id=CTRL%201"]
    assert result == {
        "group_id": "CTRL 1",
        "imported": 2,
        "skipped": 0,
        "conversation_ids": ["syn-002", "syn-001"],
        "errors": [],
    }
    detail = client.get("/conversations/syn-001").json()
    assert [turn["index"] for turn in detail["turns"]] == [0, 1, 2]
    assert detail["turns"][1]["text"] == detail["turns"][2]["text"] == "Здравствуйте, я Анна."
    assert detail["group_id"] == "CTRL 1"


def test_group_id_falls_back_to_settings_and_is_required(make_client):
    payload = make_payload([make_record()], "ENV")
    client = make_client(transport=transport_for(payload), cqa_group_id="ENV")
    assert client.post("/imports").json()["group_id"] == "ENV"

    client = make_client(transport=transport_for(payload), cqa_group_id=None)
    assert client.post("/imports", json={}).status_code == 422


def test_unknown_fields_and_roles_are_reported_but_imported(make_client):
    record = make_record(new_field=1)
    record["transcript"].append(
        {"timestamp": "00:09", "speaker": "supervisor", "text": "Текст", "mood": "ok"}
    )
    client = make_client(transport=transport_for(make_payload([record])))

    result = client.post("/imports", json={"group_id": "DEV"}).json()

    assert result["imported"] == 1 and result["skipped"] == 0
    text = " ".join(result["errors"])
    assert "new_field" in text and "supervisor" in text and "mood" in text
    assert client.get("/conversations/syn-001").json()["turns"][3]["speaker"] == "supervisor"


def test_broken_and_duplicate_records_do_not_cancel_the_rest(make_client):
    secret_text = "СЕКРЕТНЫЙ ТЕКСТ РЕПЛИКИ"
    records = [
        make_record("syn-001"),
        {"conversation_id": "syn-bad", "channel": "agent chat", "language": "RU"},
        make_record("syn-bad2", transcript=[{"speaker": "client", "text": secret_text, "timestamp": None}]),
        make_record("syn-bad3", transcript=[{"speaker": "client", "text": None, "timestamp": "0"}]),
        make_record("syn-bad4", transcript="not a list"),
        "not an object",
        make_record("syn-001"),
        make_record("syn-002"),
    ]
    client = make_client(transport=transport_for(make_payload(records)))

    result = client.post("/imports", json={"group_id": "DEV"}).json()

    assert result["conversation_ids"] == ["syn-001", "syn-002"]
    assert result["skipped"] == 6
    assert len(result["errors"]) == 6
    assert secret_text not in json.dumps(result, ensure_ascii=False)


def test_total_records_mismatch_is_reported(make_client):
    payload = make_payload([make_record()])
    payload["data"]["total_records"] = 2
    client = make_client(transport=transport_for(payload))
    result = client.post("/imports", json={"group_id": "DEV"}).json()
    assert result["imported"] == 1
    assert "total_records" in result["errors"][0]


def test_failed_upstream_response_is_an_error(make_client):
    payload = {"error": f"denied for {API_URL}", "isSuccess": False, "data": None}
    client = make_client(transport=transport_for(payload))
    response = client.post("/imports", json={"group_id": "DEV"})
    assert response.status_code == 502
    assert isinstance(response.json()["detail"], str)
    assert "APISIGNATURE456" not in response.text


def test_signature_is_masked_when_the_http_client_fails(make_client, caplog):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"cannot reach {request.url}", request=request)

    caplog.set_level(logging.DEBUG)
    client = make_client(transport=httpx.MockTransport(handler))

    response = client.post("/imports", json={"group_id": "DEV"})

    assert response.status_code == 502
    assert "ConnectError" in response.json()["detail"]
    assert "APISIGNATURE456" not in response.text
    assert "APISIGNATURE456" not in caplog.text


def test_signature_is_masked_on_a_bad_status_and_success_logs(make_client, caplog):
    caplog.set_level(logging.INFO)
    client = make_client(transport=httpx.MockTransport(lambda _: httpx.Response(503)))
    response = client.post("/imports", json={"group_id": "DEV"})
    assert response.status_code == 502 and "503" in response.json()["detail"]
    assert "APISIGNATURE456" not in response.text

    client = make_client(transport=transport_for(make_payload([make_record()])))
    assert client.post("/imports", json={"group_id": "DEV"}).status_code == 200
    assert "APISIGNATURE456" not in caplog.text


def test_missing_api_url_is_a_clear_error(make_client):
    client = make_client(cqa_api_url=None)
    response = client.post("/imports", json={"group_id": "DEV"})
    assert response.status_code == 503
    assert "CQA_API_URL" in response.json()["detail"]


def test_post_transcript_returns_summary_with_warnings(client):
    response = client.post("/transcripts", json=make_record(extra_field="x"))
    assert response.status_code == 200
    body = response.json()
    assert body["turn_count"] == 3 and body["group_id"] is None
    assert body["latest_evaluation_id"] is None
    assert "extra_field" in body["warnings"][0]


def test_post_transcript_rejects_a_broken_record_without_echo(client):
    response = client.post(
        "/transcripts", json={"conversation_id": "x", "audio_url": AUDIO_URL}
    )
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)
    assert "AUDIOSIGNATURE123" not in response.text


def test_conversation_filters(client):
    client.post("/transcripts", json=make_record("a", channel="voice call"))
    client.post("/transcripts", json=make_record("b", language="KZ"))
    assert [c["id"] for c in client.get("/conversations").json()] == ["a", "b"]
    assert [c["id"] for c in client.get("/conversations?channel=voice call").json()] == ["a"]
    assert [c["id"] for c in client.get("/conversations?language=KZ").json()] == ["b"]
    assert client.get("/conversations/none").status_code == 404
