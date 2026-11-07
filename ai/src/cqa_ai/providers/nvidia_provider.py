"""NVIDIA's hosted API: the OpenAI-compatible provider with the `nvidia` profile.

Kept as a module so existing imports keep working; all logic lives in
`openai_compat.py`.
"""

from __future__ import annotations

import httpx

from cqa_ai.providers.openai_compat import _accepted_mode, OpenAICompatProvider
from cqa_ai.providers.profiles import PROFILES

BASE_URL = PROFILES["nvidia"].base_url
MODES = PROFILES["nvidia"].json_modes

__all__ = ["BASE_URL", "MODES", "NvidiaProvider", "_accepted_mode"]


class NvidiaProvider(OpenAICompatProvider):
    def __init__(self, http_client: httpx.AsyncClient | None = None) -> None:
        super().__init__(PROFILES["nvidia"], http_client=http_client)
