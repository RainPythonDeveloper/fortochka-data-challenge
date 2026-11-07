"""Models on NVIDIA's hosted API, which speaks the OpenAI protocol.

NVIDIA documents `nvext.guided_json` for schema-constrained output on NIM, but
that is written for self-hosted NIM and the hosted endpoint is not confirmed to
accept it. So the modes are tried in order and the first one a model accepts is
remembered. The validator checks the reply in every mode, including the last one,
which relies on the prompt alone.
"""

from __future__ import annotations

import os
from typing import Any

import httpx
import openai

from cqa_ai.contracts import EvaluatorConfig
from cqa_ai.providers.base import (
    PermanentProviderError,
    ProviderResponse,
    TransientProviderError,
)

BASE_URL = "https://integrate.api.nvidia.com/v1"
# Free endpoints are reported to hang for minutes, so a stuck call must end.
DEFAULT_TIMEOUT_SECONDS = 120.0
MODES = ("guided_json", "response_format", "prompt_only")

_accepted_mode: dict[str, str] = {}


def _mode_arguments(mode: str, schema: dict[str, Any]) -> dict[str, Any]:
    if mode == "guided_json":
        return {"extra_body": {"nvext": {"guided_json": schema}}}
    if mode == "response_format":
        return {
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "evaluation", "schema": schema, "strict": True},
            }
        }
    return {}


def _retry_after(error: openai.APIStatusError) -> float | None:
    value = error.response.headers.get("retry-after")
    try:
        return float(value) if value is not None else None
    except ValueError:
        return None


class NvidiaProvider:
    name = "nvidia"
    cost_per_call = 0.0

    def __init__(self, http_client: httpx.AsyncClient | None = None) -> None:
        timeout = float(os.environ.get("CQA_LLM_TIMEOUT_S", DEFAULT_TIMEOUT_SECONDS))
        # Retries live in the pipeline so that every attempt is logged.
        self._client = openai.AsyncOpenAI(
            base_url=BASE_URL,
            api_key=os.environ.get("NVIDIA_API_KEY", ""),
            max_retries=0,
            timeout=timeout,
            http_client=http_client,
        )

    async def complete(
        self, *, system: str, user: str, schema: dict[str, Any], config: EvaluatorConfig
    ) -> ProviderResponse:
        known = _accepted_mode.get(config.model)
        modes = (known,) if known else MODES
        rejected: openai.APIStatusError | None = None
        for mode in modes:
            try:
                response = await self._client.chat.completions.create(
                    model=config.model,
                    temperature=config.temperature or 0,
                    max_tokens=config.max_output_tokens,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    **_mode_arguments(mode, schema),
                )
            except (openai.BadRequestError, openai.UnprocessableEntityError) as error:
                rejected = error
                continue
            except openai.RateLimitError as error:
                raise TransientProviderError(
                    "NVIDIA rate limit reached", retry_after=_retry_after(error)
                ) from error
            except openai.APIConnectionError as error:
                raise TransientProviderError(f"NVIDIA did not respond: {error}") from error
            except openai.APIStatusError as error:
                if error.status_code >= 500:
                    raise TransientProviderError(
                        f"NVIDIA server error {error.status_code}"
                    ) from error
                raise PermanentProviderError(
                    f"NVIDIA refused the call, {error.status_code}: {error.message}"
                ) from error

            _accepted_mode[config.model] = mode
            choice = response.choices[0]
            usage = response.usage
            return ProviderResponse(
                text=choice.message.content or "",
                model=response.model or config.model,
                input_tokens=usage.prompt_tokens if usage else None,
                output_tokens=usage.completion_tokens if usage else None,
                truncated=choice.finish_reason == "length",
            )
        raise PermanentProviderError(f"NVIDIA rejected every output mode: {rejected}")
