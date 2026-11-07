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

`evaluate` бросает `EvaluatorNotConfigured`, если провайдер не настроен или нет ключа. Сбой модели исключением не является: приходит `EvaluationOutput`, где у всех критериев статус `failed`, причина в `justification`, попытки в `attempts`. Такой запуск считается сбойным и не используется как кэш. Так же приходит отказ отправить звонок, `review_reasons` содержит `personal_data_not_sent`. `calculate_score` бросает `ScoringError`, если ответ нарушает рубрику. Провайдер `mock` не вызывает модель, его результаты помечены `mock_provider`, и это нужно показывать в интерфейсе.

## HTTP API

Базовый адрес настраивается. JSON, UTF-8. Ошибки: статус 4xx или 5xx и тело `{"detail": "..."}`.

| Метод и путь | Тело | Ответ |
|---|---|---|
| `GET /health` | | `{"status": "ok"}` |
| `POST /imports` | `{"group_id": "DEV"}` | `ImportResult` |
| `POST /transcripts` | Запись в формате API организаторов | `ConversationSummary` и `warnings: string[]` |
| `GET /conversations` | Параметры `channel`, `language` | `ConversationSummary[]` |
| `GET /conversations/{id}` | | `ConversationDetail` |
| `GET /conversations/{id}/audio` | | 302 на подписанный `audio_url` или 404 |
| `GET /checklists` | | `ChecklistSummary[]` |
| `POST /checklists` | `ChecklistVersion`, `version` игнорируется, `checklist_id` из тела или генерируется | `ChecklistVersion` с `version=1`. Занятый id даёт 409, недопустимые символы в id дают 422 |
| `GET /checklists/{id}` | | `ChecklistVersion`, последняя версия |
| `GET /checklists/{id}/versions/{version}` | | `ChecklistVersion` |
| `POST /checklists/{id}/versions` | `ChecklistVersion`, поле `version` игнорируется | Новая `ChecklistVersion` |
| `POST /evaluations` | `EvaluationRequest` | `Job` |
| `GET /jobs/{id}` | | `Job` |
| `GET /evaluations` | Параметр `conversation_id` | `EvaluationSummary[]` |
| `GET /evaluations/compare` | Параметры `a`, `b`: id запусков одного диалога | `EvaluationComparison`. Разные диалоги или сбойный запуск дают 422 |
| `GET /evaluations/{id}` | | `EvaluationRun` |
| `POST /appeals` | `AppealCreate` | `Appeal` |
| `GET /appeals` | Параметры `status`, `evaluation_id` | `Appeal[]` |
| `POST /appeals/{id}/decisions` | `DecisionCreate` | `Appeal` с решением |
| `GET /exports/ai-results` | Параметры `format=json\|csv`, `group_id`, `checklist_id` | `AiResultsExport`: исходные автоматические результаты последнего запуска диалога |
| `GET /reports/summary` | Параметр `group_id` | `ReportSummary` |

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
  conversation_ids: string[];
  checklist_id?: string;                           // один чек-лист на все диалоги
  version?: number;                                // только вместе с checklist_id
  checklists_by_channel?: Record<string, string>;  // вместе с checklist_id даёт 422
  force?: boolean;
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
  error: string | null;              // текст сбоя
};
type EvaluationRun = EvaluationSummary & {
  results: CriterionResult[];        // исходный ответ модели, не меняется
  score: ScoreSummary;               // исходный итог
  final_results: CriterionResult[];  // после решений по апелляциям
  final_score: ScoreSummary;
  checklist: ChecklistVersion | null; // замороженная версия. null: для канала нет чек-листа, тогда checklist_id "" и checklist_version 0
  review_status: "clear" | "flagged"; review_reasons: string[];
  log: {
    run_id: string; content_hash: string; checklist_hash: string; prompt_hash: string;
    pipeline: string; attempts: ModelAttempt[]; cache_hit: boolean;
    cached_from: string | null; evaluator: Record<string, unknown> | null;
    latency_ms: number | null; cost_usd: number | null;
  };
};

type AiResultsExport = {
  group_id: string | null; generated_at: string;
  total: number; done: number; failed: number; not_evaluated: number;
  results: unknown[];
};

type ReportBreakdown = {
  key: string; conversations: number; evaluated: number;
  failed: number; not_evaluated: number;
};
type ReportSummary = {
  group_id: string | null; generated_at: string;
  conversations: number; evaluated: number; failed: number;
  not_evaluated: number; partial: number;
  by_language: ReportBreakdown[]; by_channel: ReportBreakdown[];
  runs: number; failed_runs: number; cache_hits: number; model_attempts: number;
  avg_latency_ms: number | null; total_cost_usd: number; runs_without_cost: number;
  checklists: { checklist_id: string; version: number; conversations: number }[];
  evaluators: {
    provider: string; model: string; pipeline: string;
    temperature: number | null; max_output_tokens: number; conversations: number;
  }[];
  mock_used: boolean;
};

type ComparedRun = {
  id: string; checklist_id: string; checklist_version: number;
  total: number | null; final_total: number | null;
  gross_error: boolean; final_gross_error: boolean;
  cache_hit: boolean; created_at: string;
};
type ComparedCriterion = {
  status: string; answer: "yes" | "no" | number | null; weight: number;
  effective_weight: number | null; points: number | null;
};
type EvaluationComparison = {
  conversation_id: string; a: ComparedRun; b: ComparedRun;
  same_content: boolean; same_rubric: boolean;
  total_delta: number | null; final_total_delta: number | null;
  changed_criteria: string[];
  criteria: {
    criterion_id: string; title: string;
    a: ComparedCriterion | null; b: ComparedCriterion | null;  // null: критерия нет в этой версии
    answer_changed: boolean; points_changed: boolean; points_delta: number | null;
  }[];
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

Предупреждения импорта лежат в `ImportResult.errors` с префиксом `warning:`. `Job.done` считает только успешные диалоги. `latest_total` и `gross_error` у диалога показывают состояние после решений по апелляциям. Сбойный запуск имеет пустой `results` и `ScoreSummary` с итогом `null`.

## Выбор чек-листа

Если `checklist_id` не указан, чек-лист выбирается для каждого диалога по каналу:

1. Канал есть в `checklists_by_channel`: берётся назначенный чек-лист, его последняя версия.
2. Канал заявлен в одном чек-листе: берётся он.
3. Канал заявлен в нескольких, и один из них стандартный: берётся стандартный, его последняя версия.
4. Канал заявлен в нескольких без единственного стандартного: ответ 422 с каналом и списком id.
5. Канал не заявлен нигде: диалог получает `failed` и `checklist: null`, остальные продолжаются.

Стандартные чек-листы лежат файлами в `ai/src/cqa_ai/checklists/`: `freedom-chat-quality` и `freedom-voice-quality`. У каждого канала должен быть один стандартный чек-лист.

## Контрольный прогон

```bash
cd backend
uv run python -m cqa_backend.control --group-id <значение>
```

Параметры и коды выхода описаны в `backend/README.md`. Экспорт берёт последний запуск диалога, поэтому результаты контроля сохраняются сразу после прогона, а новые запуски на других версиях чек-листа делаются после этого.

## Правила, общие для всех частей

- Реплика адресуется только по `Turn.index`. Метки времени повторяются.
- `audio_url` не отдаётся в браузер и не пишется в логи. Интерфейс идёт через `GET /conversations/{id}/audio`.
- Апелляция не меняет `results` и `score`. Меняются только `final_results` и `final_score`.
- Экспорт отдаёт исходный автоматический результат.
- Повторная оценка с тем же `content_hash`, `checklist_hash` и конфигурацией берётся из кэша, если нет `force`. Если изменился только вес, итог пересчитывается без вызова модели.
