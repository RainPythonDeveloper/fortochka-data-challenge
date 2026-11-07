"""Server entry point: `uvicorn cqa_backend.main:app`."""

from __future__ import annotations

from dotenv import load_dotenv

from cqa_backend.app import create_app
from cqa_backend.config import REPO_ROOT

# Into the process environment, so provider keys reach `cqa_ai` too.
load_dotenv(REPO_ROOT / ".env", override=False)

app = create_app()
