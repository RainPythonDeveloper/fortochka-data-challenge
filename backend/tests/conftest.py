"""Synthetic fixtures only. Real dialogues and signed links never belong here."""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from contextlib import ExitStack
from typing import Any

import pytest
from cqa_ai import evaluate
from cqa_ai.contracts import EvaluatorConfig
from fastapi.testclient import TestClient

from cqa_backend.app import create_app
from cqa_backend.config import Settings

SIG_PARAM = "sig"  # kept apart so the pre-push secret scan stays clean
API_URL = f"https://api.example.test/export?code=abc&{SIG_PARAM}=APISIGNATURE456"
AUDIO_URL = f"https://api.example.test/play?id=1&{SIG_PARAM}=AUDIOSIGNATURE123"
CHECKLIST_ID = "freedom-chat-quality"


def make_record(conversation_id: str = "syn-001", **overrides: Any) -> dict[str, Any]:
    record = {
        "conversation_id": conversation_id,
        "channel": "agent chat",
        "language": "RU",
        "transcript": [
            {"timestamp": "00:00", "speaker": "client", "text": "Вопрос про тариф?"},
            {"timestamp": "00:00", "speaker": "operator", "text": "Здравствуйте, я Анна."},
            {"timestamp": "00:05", "speaker": "operator", "text": "Здравствуйте, я Анна."},
        ],
        "audio_url": None,
    }
    return {**record, **overrides}


def make_payload(records: list[Any], group_id: str = "DEV") -> dict[str, Any]:
    return {
        "error": "",
        "isSuccess": True,
        "data": {
            "dataset_group_id": group_id,
            "total_records": len(records),
            "records": records,
        },
    }


class CountingEvaluator:
    """The mock evaluator with a call counter, optional failures and a c01 = no."""

    def __init__(self, fail_for: set[str] | None = None, c01: str = "no") -> None:
        self.calls: list[str] = []
        self.fail_for = fail_for or set()
        self.c01 = c01

    async def __call__(self, snapshot, checklist, config):  # noqa: ANN001
        self.calls.append(snapshot.conversation_id)
        if snapshot.conversation_id in self.fail_for:
            raise RuntimeError(f"provider exploded at {AUDIO_URL}")
        output = await evaluate(snapshot, checklist, EvaluatorConfig())
        for result in output.results:
            if result.criterion_id == "c01":
                result.answer = self.c01
        return output


def wait_for_job(client: TestClient, job_id: str, timeout_s: float = 5) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        job = client.get(f"/jobs/{job_id}").json()
        if job["status"] in ("done", "failed"):
            return job
        time.sleep(0.01)
    raise AssertionError(f"job did not finish: {job}")


def run_job(client: TestClient, ids: list[str], **extra: Any) -> dict[str, Any]:
    body = {"conversation_ids": ids, "checklist_id": CHECKLIST_ID, **extra}
    response = client.post("/evaluations", json=body)
    assert response.status_code == 200, response.text
    return wait_for_job(client, response.json()["id"])


def put(client: TestClient, *ids: str) -> None:
    for item in ids:
        assert client.post("/transcripts", json=make_record(item)).status_code == 200


def new_version(client: TestClient, change: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    body = client.get(f"/checklists/{CHECKLIST_ID}").json()
    change(body)
    response = client.post(f"/checklists/{CHECKLIST_ID}/versions", json=body)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def settings(tmp_path) -> Settings:  # noqa: ANN001
    return Settings(
        _env_file=None,
        cqa_db_path=tmp_path / "test.sqlite",
        cqa_api_url=API_URL,
        cqa_allow_mock=True,
        cqa_eval_pause_s=0,
        llm_provider=None,
        llm_model=None,
    )


@pytest.fixture
def make_client(settings: Settings) -> Iterator[Callable[..., TestClient]]:
    with ExitStack() as stack:

        def factory(evaluator=None, transport=None, **overrides: Any) -> TestClient:  # noqa: ANN001
            app = create_app(settings.model_copy(update=overrides), evaluator, transport)
            return stack.enter_context(TestClient(app))

        yield factory


@pytest.fixture
def client(make_client) -> TestClient:  # noqa: ANN001
    return make_client()
