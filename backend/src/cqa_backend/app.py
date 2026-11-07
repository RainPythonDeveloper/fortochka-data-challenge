"""FastAPI application. Routes stay thin, the logic lives in the service modules."""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Literal

import httpx
from cqa_ai import ScoringError, evaluate
from cqa_ai.contracts import ChecklistVersion
from fastapi import Body, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response

from cqa_backend import appeals, checklists, conversations, exports
from cqa_backend.config import Settings
from cqa_backend.db import Database
from cqa_backend.errors import ApiError
from cqa_backend.evaluations import EvaluationService, Evaluator
from cqa_backend.redact import redact, register_secret, setup_logging
from cqa_backend.schemas import (
    Appeal,
    AppealCreate,
    ChecklistSummary,
    ConversationDetail,
    ConversationSummary,
    DecisionCreate,
    EvaluationRequest,
    EvaluationRun,
    EvaluationSummary,
    ImportRequest,
    ImportResult,
    Job,
    TranscriptResult,
)

logger = logging.getLogger(__name__)


def create_app(
    settings: Settings | None = None,
    evaluator: Evaluator | None = None,
    transport: httpx.BaseTransport | None = None,
) -> FastAPI:
    settings = settings or Settings()
    for secret in (
        settings.cqa_api_url,
        os.environ.get("OPENAI_API_KEY"),
        os.environ.get("ANTHROPIC_API_KEY"),
    ):
        register_secret(secret)
    setup_logging()
    db = Database(settings.cqa_db_path)
    service = EvaluationService(db, settings, evaluator or evaluate)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        checklists.seed_defaults(db)
        service.recover()
        yield
        await service.shutdown()

    app = FastAPI(title="CQA backend", version="0.1.0", lifespan=lifespan)
    app.state.db = db
    app.state.service = service

    @app.middleware("http")
    async def hide_unexpected_errors(request: Request, call_next: Any) -> Response:
        # Caught here so the raw traceback text never reaches the server log.
        try:
            return await call_next(request)
        except Exception as exc:  # noqa: BLE001
            logger.error("%s %s failed: %s", request.method, request.url.path, type(exc).__name__)
            return JSONResponse({"detail": "Внутренняя ошибка сервера"}, status_code=500)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(ApiError)
    async def api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)

    @app.exception_handler(ScoringError)
    async def scoring_error(_: Request, exc: ScoringError) -> JSONResponse:
        return JSONResponse({"detail": redact(exc)}, status_code=422)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        # The default body echoes the input, which may hold audio_url or dialogue text.
        parts = [
            f"{'.'.join(str(item) for item in error['loc'])}: {error['msg']}"
            for error in exc.errors()
        ]
        return JSONResponse({"detail": redact("; ".join(parts))}, status_code=422)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/imports", response_model=ImportResult)
    def create_import(body: ImportRequest | None = None) -> ImportResult:
        group_id = ((body.group_id if body else None) or settings.cqa_group_id or "").strip()
        if not group_id:
            raise ApiError(422, "Не указан group_id")
        payload = conversations.fetch_payload(
            settings.cqa_api_url, group_id, settings.cqa_http_timeout_s, transport
        )
        return conversations.ingest_payload(db, payload, group_id)

    @app.post("/transcripts", response_model=TranscriptResult)
    def create_transcript(record: dict[str, Any] = Body(...)) -> TranscriptResult:
        conversation_id, warnings = conversations.ingest_record(db, record)
        if warnings:
            logger.warning("transcript %s: %d warnings", conversation_id, len(warnings))
        summary = conversations.get_summary(db, conversation_id)
        return TranscriptResult(**summary, warnings=warnings)

    @app.get("/conversations", response_model=list[ConversationSummary])
    def get_conversations(
        channel: str | None = None, language: str | None = None
    ) -> list[ConversationSummary]:
        return conversations.list_conversations(db, channel, language)

    @app.get("/conversations/{conversation_id}", response_model=ConversationDetail)
    def get_conversation(conversation_id: str) -> ConversationDetail:
        return conversations.get_conversation(db, conversation_id)

    @app.get("/conversations/{conversation_id}/audio")
    def get_audio(conversation_id: str) -> RedirectResponse:
        return RedirectResponse(conversations.get_audio_url(db, conversation_id), status_code=302)

    @app.get("/checklists", response_model=list[ChecklistSummary])
    def get_checklists() -> list[ChecklistSummary]:
        return checklists.list_checklists(db)

    @app.get("/checklists/{checklist_id}", response_model=ChecklistVersion)
    def get_checklist(checklist_id: str) -> ChecklistVersion:
        return checklists.get_checklist(db, checklist_id)

    @app.get("/checklists/{checklist_id}/versions/{version}", response_model=ChecklistVersion)
    def get_checklist_version(checklist_id: str, version: int) -> ChecklistVersion:
        return checklists.get_checklist(db, checklist_id, version)

    @app.post("/checklists/{checklist_id}/versions", response_model=ChecklistVersion)
    def create_checklist_version(
        checklist_id: str, body: dict[str, Any] = Body(...)
    ) -> ChecklistVersion:
        return checklists.create_version(db, checklist_id, body)

    @app.post("/evaluations", response_model=Job)
    async def create_evaluation(body: EvaluationRequest) -> Job:
        return service.create_job(body)

    @app.get("/jobs/{job_id}", response_model=Job)
    def get_job(job_id: str) -> Job:
        return service.get_job(job_id)

    @app.get("/evaluations", response_model=list[EvaluationSummary])
    def get_evaluations(conversation_id: str | None = None) -> list[EvaluationSummary]:
        return service.list_runs(conversation_id)

    @app.get("/evaluations/{run_id}", response_model=EvaluationRun)
    def get_evaluation(run_id: str) -> EvaluationRun:
        return service.get_run(run_id)

    @app.post("/appeals", response_model=Appeal)
    def create_appeal(body: AppealCreate) -> Appeal:
        return appeals.create_appeal(db, body)

    @app.get("/appeals", response_model=list[Appeal])
    def get_appeals(status: Literal["open", "decided"] | None = None) -> list[Appeal]:
        return appeals.list_appeals(db, status)

    @app.post("/appeals/{appeal_id}/decisions", response_model=Appeal)
    def create_decision(appeal_id: str, body: DecisionCreate) -> Appeal:
        return appeals.decide(db, appeal_id, body)

    @app.get("/exports/ai-results")
    def export_ai_results(
        format: Literal["json", "csv"] = Query("json"),
        group_id: str | None = None,
        checklist_id: str | None = None,
    ) -> Response:
        export = exports.collect(db, group_id, checklist_id)
        if format == "json":
            return JSONResponse(export)
        return Response(
            exports.to_csv(export),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="ai-results.csv"'},
        )

    return app
