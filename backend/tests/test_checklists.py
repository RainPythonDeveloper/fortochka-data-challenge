import sqlite3

import pytest
from conftest import CHECKLIST_ID, new_version


def test_defaults_are_loaded_once(make_client):
    client = make_client()
    assert client.get("/checklists").json() == [
        {
            "checklist_id": CHECKLIST_ID,
            "title": client.get(f"/checklists/{CHECKLIST_ID}").json()["title"],
            "latest_version": 1,
            "channels": ["agent chat"],
        }
    ]
    assert len(make_client().get("/checklists").json()) == 1


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
