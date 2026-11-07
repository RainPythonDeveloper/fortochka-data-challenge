import sqlite3

import pytest
from cqa_ai import load_default_checklists
from conftest import CHECKLIST_ID, make_record, new_version, run_job


def test_defaults_are_loaded_once(make_client):
    client = make_client()
    listed = client.get("/checklists").json()
    assert {item["checklist_id"] for item in listed} == {
        item.checklist_id for item in load_default_checklists()
    }
    chat = next(item for item in listed if item["checklist_id"] == CHECKLIST_ID)
    assert chat["latest_version"] == 1 and chat["channels"] == ["agent chat"]
    assert make_client().get("/checklists").json() == listed


def test_new_version_ignores_the_version_field(client):
    body = client.get(f"/checklists/{CHECKLIST_ID}").json()
    body["title"] = "Новое название"
    for value in (99, 0):
        body["version"] = value
        client.post(f"/checklists/{CHECKLIST_ID}/versions", json=body)
    del body["version"]
    created = client.post(f"/checklists/{CHECKLIST_ID}/versions", json=body).json()

    assert created["version"] == 4
    assert client.get(f"/checklists/{CHECKLIST_ID}").json()["version"] == 4
    old = client.get(f"/checklists/{CHECKLIST_ID}/versions/1").json()
    assert old["title"] != "Новое название"


def test_new_criterion_is_accepted_and_broken_rubric_is_rejected(client):
    def add(body):
        body["criteria"].append(
            {
                "id": "c99",
                "section": body["sections"][0]["id"],
                "title": "Новый критерий",
                "type": "boolean",
                "weight": 5,
            }
        )

    assert new_version(client, add)["criteria"][-1]["id"] == "c99"

    body = client.get(f"/checklists/{CHECKLIST_ID}").json()
    body["criteria"][0]["allow_na"] = True
    body["criteria"][0]["na_when"] = None
    response = client.post(f"/checklists/{CHECKLIST_ID}/versions", json=body)
    assert response.status_code == 422 and isinstance(response.json()["detail"], str)
    assert client.get(f"/checklists/{CHECKLIST_ID}").json()["version"] == 2


def test_wrong_ids_and_missing_versions(client):
    body = client.get(f"/checklists/{CHECKLIST_ID}").json()
    assert client.post("/checklists/none/versions", json={**body, "checklist_id": "none"}).status_code == 404
    assert client.post(f"/checklists/{CHECKLIST_ID}/versions", json={**body, "checklist_id": "x"}).status_code == 422
    assert client.get("/checklists/none").status_code == 404
    assert client.get(f"/checklists/{CHECKLIST_ID}/versions/7").status_code == 404


def test_versions_cannot_be_deleted_or_changed(client):
    assert client.delete(f"/checklists/{CHECKLIST_ID}").status_code == 405
    assert client.delete(f"/checklists/{CHECKLIST_ID}/versions/1").status_code == 405
    with client.app.state.db.read() as conn:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("DELETE FROM checklist_versions")
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("UPDATE checklist_versions SET body_json = '{}'")


def rubric(client, **extra):
    body = client.get(f"/checklists/{CHECKLIST_ID}").json()
    del body["checklist_id"], body["version"]
    return {**body, **extra}


def test_user_creates_a_checklist_with_version_one(client):
    before = len(client.get("/checklists").json())
    response = client.post(
        "/checklists", json=rubric(client, checklist_id="my-list", version=7, title="Мой")
    )
    assert response.status_code == 200, response.text
    created = response.json()
    assert created["checklist_id"] == "my-list" and created["version"] == 1
    assert client.get("/checklists/my-list").json()["title"] == "Мой"
    assert len(client.get("/checklists").json()) == before + 1

    body = client.get("/checklists/my-list").json()
    assert client.post("/checklists/my-list/versions", json=body).json()["version"] == 2


def test_checklist_id_is_generated_when_absent(client):
    first = client.post("/checklists", json=rubric(client)).json()
    second = client.post("/checklists", json=rubric(client, checklist_id="")).json()
    assert first["checklist_id"] != second["checklist_id"]
    assert client.get(f"/checklists/{first['checklist_id']}").status_code == 200


def test_taken_id_is_a_conflict_and_nothing_changes(client):
    response = client.post(
        "/checklists", json=rubric(client, checklist_id=CHECKLIST_ID, title="Чужой")
    )
    assert response.status_code == 409 and isinstance(response.json()["detail"], str)
    latest = client.get(f"/checklists/{CHECKLIST_ID}").json()
    assert latest["version"] == 1 and latest["title"] != "Чужой"


def test_broken_new_checklist_is_rejected(client):
    before = client.get("/checklists").json()
    for body in (
        rubric(client, checklist_id="a/b"),
        rubric(client, checklist_id=5),
        rubric(client, criteria=[]),
        {"title": "Без критериев"},
    ):
        response = client.post("/checklists", json=body)
        assert response.status_code == 422, body
        assert isinstance(response.json()["detail"], str)
    assert client.get("/checklists").json() == before


def test_created_checklist_can_be_used_for_evaluation(client):
    client.post("/checklists", json=rubric(client, checklist_id="my-list"))
    client.post("/transcripts", json=make_record())
    job = run_job(client, ["syn-001"], checklist_id="my-list")
    assert job["status"] == "done"
    assert client.get("/evaluations").json()[0]["checklist_id"] == "my-list"
