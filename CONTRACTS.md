# Контракты между частями проекта

Здесь зафиксировано то, на чём сходятся три ветки. Бизнес-контекст в [AGENTS.md](AGENTS.md).

## Кто за что отвечает

| Папка | Ветка | Что внутри |
|---|---|---|
| `frontend/` | `feat/frontend` | Интерфейс: список, карточка, редактор чек-листа, апелляция |
| `backend/` | `feat/backend` | HTTP API, импорт, SQLite, jobs, версии чек-листов, апелляции, экспорт |
| `ai/` | `feat/ai` | Контракты, расчёт, рубрика, промпт, провайдеры, валидация, eval |

Каждая ветка меняет только свою папку. Корневые файлы меняются отдельным коммитом в `main`, чтобы не ловить конфликты.

Зависимости идут в одну сторону: `frontend` ходит в `backend` по HTTP, `backend` импортирует `cqa_ai` как локальный пакет `../ai`. Пакет `ai` ничего не знает про `backend`.

## Изменение контракта

Изменение контракта требует договорённости всех владельцев. Порядок: правка в `main`, затем слияние `main` в ветки. Если контракта не хватает, сделайте минимальный адаптер в своей папке и сообщите об этом, а не меняйте чужую.

## Python: публичный интерфейс `cqa_ai`

Модели лежат в `ai/src/cqa_ai/contracts.py`, это единственный источник формы данных.

```python
snapshot_from_record(record: dict) -> ConversationSnapshot
load_default_checklists() -> list[ChecklistVersion]
calculate_score(checklist, results) -> ScoreSummary
content_hash(snapshot) -> str
checklist_hash(checklist) -> str          # не меняется при правке только веса
async evaluate(snapshot, checklist, config) -> EvaluationOutput
```

`evaluate` бросает `EvaluatorNotConfigured`, если провайдер не настроен. `calculate_score` бросает `ScoringError`, если ответ нарушает рубрику. Провайдер `mock` не вызывает модель, его результаты помечены `mock_provider`, и это нужно показывать в интерфейсе.

## HTTP API

Базовый адрес настраивается. JSON, UTF-8. Ошибки: статус 4xx или 5xx и тело `{"detail": "..."}`.

| Метод и путь | Тело | Ответ |
|---|---|---|
| `GET /health` | | `{"status": "ok"}` |
| `POST /imports` | `{"group_id": "DEV"}` | `ImportResult` |
| `POST /transcripts` | Запись в формате API организаторов | `ConversationSummary` |
| `GET /conversations` | Параметры `channel`, `language` | `ConversationSummary[]` |
| `GET /conversations/{id}` | | `ConversationDetail` |
| `GET /conversations/{id}/audio` | | 302 на подписанный `audio_url` или 404 |
| `GET /checklists` | | `ChecklistSummary[]` |
| `GET /checklists/{id}` | | `ChecklistVersion`, последняя версия |
| `GET /checklists/{id}/versions/{version}` | | `ChecklistVersion` |
| `POST /checklists/{id}/versions` | `ChecklistVersion`, поле `version` игнорируется | Новая `ChecklistVersion` |
| `POST /evaluations` | `EvaluationRequest` | `Job` |
| `GET /jobs/{id}` | | `Job` |
| `GET /evaluations` | Параметр `conversation_id` | `EvaluationSummary[]` |
| `GET /evaluations/{id}` | | `EvaluationRun` |
| `POST /appeals` | `AppealCreate` | `Appeal` |
| `GET /appeals` | Параметр `status` | `Appeal[]` |
| `POST /appeals/{id}/decisions` | `DecisionCreate` | `Appeal` с решением |
| `GET /exports/ai-results` | Параметры `format=json\|csv`, `group_id` | Исходные автоматические результаты |

```ts
type ImportResult = {
  group_id: string; imported: number; skipped: number;
  conversation_ids: string[]; errors: string[];
};
type ConversationSummary = {
  id: string; channel: string; language: string; turn_count: number;
  has_audio: boolean; group_id: string | null;
  latest_evaluation_id: string | null; latest_total: number | null;
  gross_error: boolean;
};
type ConversationDetail = ConversationSummary & { turns: Turn[] };

type ChecklistSummary = {
  checklist_id: string; title: string; latest_version: number; channels: string[];
};

type EvaluationRequest = {
  conversation_ids: string[]; checklist_id: string;
  version?: number; force?: boolean;
};
type Job = {
  id: string; status: "queued" | "running" | "done" | "failed";
  total: number; done: number; failed: number;
  evaluation_ids: string[]; errors: string[];
};

type EvaluationSummary = {
  id: string; conversation_id: string; checklist_id: string; checklist_version: number;
  status: "done" | "failed"; total: number | null; final_total: number | null;
  gross_error: boolean; created_at: string;
};
type EvaluationRun = EvaluationSummary & {
  results: CriterionResult[];        // исходный ответ модели, не меняется
  score: ScoreSummary;               // исходный итог
  final_results: CriterionResult[];  // после решений по апелляциям
  final_score: ScoreSummary;
  checklist: ChecklistVersion;       // замороженная версия этого запуска
  review_status: "clear" | "flagged"; review_reasons: string[];
  log: {
    run_id: string; content_hash: string; checklist_hash: string; prompt_hash: string;
    pipeline: string; attempts: ModelAttempt[]; cache_hit: boolean;
    latency_ms: number | null; cost_usd: number | null;
  };
};

type AppealCreate = { evaluation_id: string; criterion_id: string; comment: string };
type DecisionCreate = {
  decision: "confirm" | "change";
  new_answer?: "yes" | "no" | number | null;
  new_status?: "assessed" | "not_applicable";
  reason: string; reviewer: string;
};
type Appeal = {
  id: string; evaluation_id: string; criterion_id: string; comment: string;
  status: "open" | "decided"; created_at: string;
  decision: (DecisionCreate & { decided_at: string }) | null;
};
```

`Turn`, `ChecklistVersion`, `CriterionResult`, `ScoreSummary`, `ModelAttempt` повторяют модели из `contracts.py`.

## Правила, общие для всех частей

- Реплика адресуется только по `Turn.index`. Метки времени повторяются.
- `audio_url` не отдаётся в браузер и не пишется в логи. Интерфейс идёт через `GET /conversations/{id}/audio`.
- Апелляция не меняет `results` и `score`. Меняются только `final_results` и `final_score`.
- Экспорт отдаёт исходный автоматический результат.
- Повторная оценка с тем же `content_hash`, `checklist_hash` и конфигурацией берётся из кэша, если нет `force`. Если изменился только вес, итог пересчитывается без вызова модели.
