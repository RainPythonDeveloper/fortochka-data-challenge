"""The real SDK against a fake transport: this checks what actually goes on the wire.
It does not prove the hosted endpoint accepts these requests, only a live key can."""

import asyncio
import json

import httpx
import pytest

from cqa_ai.contracts import EvaluatorConfig
from cqa_ai.providers import PermanentProviderError, TransientProviderError
from cqa_ai.providers import nvidia_provider
from cqa_ai.providers.nvidia_provider import NvidiaProvider

CONFIG = EvaluatorConfig(provider="nvidia", model="google/gemma-4-31b-it")
SCHEMA = {"type": "object"}


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")
    nvidia_provider._accepted_mode.clear()


def completion(text="{}", finish_reason="stop"):
    return {
        "id": "1",
        "object": "chat.completion",
        "created": 1,
        "model": "google/gemma-4-31b-it",
        "choices": [
            {
                "index": 0,
                "finish_reason": finish_reason,
                "message": {"role": "assistant", "content": text},
            }
        ],
        "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
    }


def make(handler):
    requests = []

    def record(request):
        requests.append(json.loads(request.content))
        return handler(request, len(requests))

    client = httpx.AsyncClient(transport=httpx.MockTransport(record))
    return NvidiaProvider(http_client=client), requests


def complete(provider, config=CONFIG):
    return asyncio.run(provider.complete(system="s", user="u", schema=SCHEMA, config=config))


def test_first_try_uses_guided_json_and_reads_usage():
    provider, requests = make(lambda request, n: httpx.Response(200, json=completion('{"a":1}')))
    response = complete(provider)
    assert requests[0]["nvext"]["guided_json"] == SCHEMA
    assert requests[0]["model"] == CONFIG.model
    assert requests[0]["messages"][0] == {"role": "system", "content": "s"}
    assert requests[0]["temperature"] == 0
    assert response.text == '{"a":1}'
    assert (response.input_tokens, response.output_tokens) == (100, 20)
    assert not response.truncated


def test_rejected_modes_fall_through_to_the_next_one():
    def handler(request, n):
        if n < 3:
            return httpx.Response(400, json={"detail": "unsupported"})
        return httpx.Response(200, json=completion())

    provider, requests = make(handler)
    complete(provider)
    assert "nvext" in requests[0]
    assert requests[1]["response_format"]["type"] == "json_schema"
    assert "nvext" not in requests[2] and "response_format" not in requests[2]


def test_the_accepted_mode_is_remembered():
    def handler(request, n):
        if n == 1:
            return httpx.Response(422, json={"detail": "unsupported"})
        return httpx.Response(200, json=completion())

    provider, requests = make(handler)
    complete(provider)
    complete(provider)
    assert len(requests) == 3
    assert "response_format" in requests[2]


def test_every_mode_rejected_is_a_permanent_failure():
    provider, requests = make(lambda r, n: httpx.Response(400, json={"detail": "bad"}))
    with pytest.raises(PermanentProviderError):
        complete(provider)
    assert len(requests) == 3


def test_rate_limit_is_transient_and_keeps_retry_after():
    provider, _ = make(
        lambda r, n: httpx.Response(429, headers={"retry-after": "7"}, json={"detail": "slow"})
    )
    with pytest.raises(TransientProviderError) as raised:
        complete(provider)
    assert raised.value.retry_after == 7
    assert "rate limit" in str(raised.value)


def test_server_errors_and_hangs_are_transient():
    provider, _ = make(lambda r, n: httpx.Response(503, json={"detail": "busy"}))
    with pytest.raises(TransientProviderError):
        complete(provider)

    def hang(request, n):
        raise httpx.ReadTimeout("hung", request=request)

    provider, _ = make(hang)
    with pytest.raises(TransientProviderError):
        complete(provider)


@pytest.mark.parametrize("status", [401, 403, 404])
def test_auth_and_removed_models_are_permanent(status):
    provider, _ = make(lambda r, n: httpx.Response(status, json={"detail": "no"}))
    with pytest.raises(PermanentProviderError, match=str(status)):
        complete(provider)


def test_truncated_output_is_reported():
    provider, _ = make(lambda r, n: httpx.Response(200, json=completion("{", "length")))
    assert complete(provider).truncated
