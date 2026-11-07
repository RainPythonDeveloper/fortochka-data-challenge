"""Any OpenAI-compatible chat endpoint, parametrised by a `ProviderProfile`.

Structured-output modes differ between vendors (NVIDIA's `nvext.guided_json`,
OpenAI-style `response_format`, or plain prompting), so they are tried in the
profile's order and the first one a model accepts is remembered. The validator
checks the reply in every mode, including the last one.
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
from cqa_ai.providers.profiles import ProviderProfile, paid_equivalent_usd
from cqa_ai.providers.ratelimit import limiter_for

# Free endpoints are reported to hang for minutes, so a stuck call must end.
DEFAULT_TIMEOUT_SECONDS = 240.0

# (provider, model) -> accepted mode
_accepted_mode: dict[tuple[str, str], str] = {}


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
    if mode == "json_object":
        return {"response_format": {"type": "json_object"}}
    return {}


def _retry_after(error: openai.APIStatusError) -> float | None:
    value = error.response.headers.get("retry-after")
    try:
        return float(value) if value is not None else None
    except ValueError:
        return None


def _is_loopback(url: str) -> bool:
    from urllib.parse import urlparse

    host = (urlparse(url).hostname or "").lower()
    return host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".localhost")


class OpenAICompatProvider:
    # Free endpoints cost nothing; paid ones set prices in their profile.
    cost_per_call: float | None = 0.0

    def __init__(
        self, profile: ProviderProfile, http_client: httpx.AsyncClient | None = None
    ) -> None:
        self.profile = profile
        self.name = profile.name
        # Personal data stays on this machine: a "local" profile pointed at another
        # host is treated like any cloud endpoint.
        self.allows_personal_data = profile.allows_personal_data and _is_loopback(profile.url())
        timeout = float(os.environ.get("CQA_LLM_TIMEOUT_S", DEFAULT_TIMEOUT_SECONDS))
        # Retries live in the pipeline so that every attempt is logged.
        self._client = openai.AsyncOpenAI(
            base_url=profile.url(),
            api_key=profile.key(),
            max_retries=0,
            timeout=timeout,
            http_client=http_client,
        )

    async def acquire_slot(self) -> int:
        return await limiter_for(self.name, self.profile.rpm).acquire()

    def cost_of(
        self, model: str, input_tokens: int | None, output_tokens: int | None
    ) -> tuple[float | None, float | None]:
        """(cost_usd, paid_equivalent_usd) of one call."""
        p = self.profile
        if input_tokens is None or output_tokens is None:
            cost = 0.0 if p.price_in_per_mtok == p.price_out_per_mtok == 0 else None
        else:
            cost = round(
                (input_tokens * p.price_in_per_mtok + output_tokens * p.price_out_per_mtok)
                / 1_000_000,
                6,
            )
        return cost, paid_equivalent_usd(model, input_tokens, output_tokens)

    async def complete(
        self, *, system: str, user: str, schema: dict[str, Any], config: EvaluatorConfig
    ) -> ProviderResponse:
        label = self.name.upper() if self.name == "nvidia" else self.name
        known = _accepted_mode.get((self.name, config.model))
        modes = (known,) if known else self.profile.json_modes
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
                    f"{label} rate limit reached", retry_after=_retry_after(error)
                ) from error
            except openai.APIConnectionError as error:
                raise TransientProviderError(f"{label} did not respond: {error}") from error
            except openai.APIStatusError as error:
                if error.status_code >= 500:
                    raise TransientProviderError(
                        f"{label} server error {error.status_code}"
                    ) from error
                raise PermanentProviderError(
                    f"{label} refused the call, {error.status_code}: {error.message}"
                ) from error

            _accepted_mode[(self.name, config.model)] = mode
            choice = response.choices[0]
            usage = response.usage
            return ProviderResponse(
                text=choice.message.content or "",
                model=response.model or config.model,
                input_tokens=usage.prompt_tokens if usage else None,
                output_tokens=usage.completion_tokens if usage else None,
                truncated=choice.finish_reason == "length",
            )
        raise PermanentProviderError(f"{label} rejected every output mode: {rejected}")
