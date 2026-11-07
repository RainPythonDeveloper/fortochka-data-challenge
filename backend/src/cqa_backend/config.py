"""Runtime settings. Everything comes from the environment, nothing is hardcoded."""

from __future__ import annotations

from pathlib import Path

from cqa_ai import EvaluatorNotConfigured
from cqa_ai.contracts import EvaluatorConfig
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_DIR.parent
MOCK_PROVIDER = "mock"


class Settings(BaseSettings):
    # `.env` is loaded into the process environment by `main.py`, so that provider
    # keys also reach `cqa_ai`. Empty values such as `LLM_PROVIDER=` mean "not set".
    model_config = SettingsConfigDict(env_ignore_empty=True, extra="ignore")

    cqa_api_url: str | None = None
    cqa_group_id: str | None = None
    cqa_db_path: Path = BACKEND_DIR / "cqa.sqlite"
    cqa_cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    cqa_http_timeout_s: float = 30
    cqa_eval_concurrency: int = Field(default=4, ge=1)
    cqa_eval_timeout_s: float = Field(default=300, gt=0)
    cqa_allow_mock: bool = False

    llm_provider: str | None = None
    llm_model: str | None = None
    llm_pipeline: str = "single"

    @property
    def cors_origins(self) -> list[str]:
        return [item.strip() for item in self.cqa_cors_origins.split(",") if item.strip()]


def resolve_evaluator_config(settings: Settings) -> EvaluatorConfig:
    """Pick the evaluator, or refuse. A real model is never replaced by the mock."""
    provider = settings.llm_provider
    if provider is None or provider == MOCK_PROVIDER:
        if settings.cqa_allow_mock:
            return EvaluatorConfig(
                provider=MOCK_PROVIDER, model=MOCK_PROVIDER, pipeline=settings.llm_pipeline
            )
        raise EvaluatorNotConfigured(
            "Оценщик не настроен: задайте LLM_PROVIDER и LLM_MODEL "
            "или включите заглушку через CQA_ALLOW_MOCK=1"
        )
    if not settings.llm_model:
        raise EvaluatorNotConfigured(f"Оценщик не настроен: для {provider!r} не задан LLM_MODEL")
    return EvaluatorConfig(
        provider=provider, model=settings.llm_model, pipeline=settings.llm_pipeline
    )
