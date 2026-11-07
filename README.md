# CQA: оценка качества диалогов

Прототип Conversation Quality Analytics для кейса Freedom Broker на Data Challenge'26. Система оценивает работу операторов в чатах и звонках по настраиваемому чек-листу, показывает баллы и доказательства, поддерживает апелляцию и пересмотр.

## Структура

| Папка | Что внутри | Ветка |
|---|---|---|
| [frontend/](frontend/) | Интерфейс: список, карточка, чек-листы, апелляции, отчёт | `feat/frontend` |
| [backend/](backend/) | API, импорт, SQLite, очередь оценок, экспорт | `feat/backend` |
| [ai/](ai/) | Рубрика, промпт, вызов модели, проверка ответа, расчёт, замеры | `feat/ai` |

[CONTRACTS.md](CONTRACTS.md) описывает, как части связаны. [AGENTS.md](AGENTS.md) содержит полный контекст задачи.

## Быстрый старт

Нужны Python 3.12 или новее, [uv](https://docs.astral.sh/uv/) и Node 24.

```bash
cp .env.example .env
```

В `.env` заполните `CQA_API_URL` (ссылку возьмите у команды) и `NVIDIA_API_KEY` (создаётся на [build.nvidia.com](https://build.nvidia.com/settings/api-keys)).

Backend:

```bash
cd backend
uv sync
uv run uvicorn cqa_backend.main:app --port 8000
```

Frontend, в другом терминале:

```bash
cd frontend
npm install
npm run dev
```

Откройте адрес, который напечатает Vite, и импортируйте группу `DEV` на экране диалогов. Интерфейс без backend, на синтетических данных: `npm run dev:mock`.

Тесты:

```bash
cd ai && uv run pytest
```

```bash
cd backend && uv run pytest
```

```bash
cd frontend && npm run build
```

## Модель и стоимость

Оценщик `google/gemma-4-31b-it` через бесплатный API NVIDIA, запасная модель `mistralai/mistral-large-4-1t-a52b`. Одна оценка диалога занимает 1 или 2 вызова модели, около 3 200 входных и 1 000–1 300 выходных токенов на вызов. API бесплатный, поэтому стоимость оценки 0.

Звонки по умолчанию в модель не отправляются: в них есть персональные данные, а бесплатный API записывает запросы. Подробности в [ai/README.md](ai/README.md).

## Как работаем

- Каждая часть меняет только свою папку в своей ветке. Корневые файлы меняются отдельным коммитом в `main`.
- Перед началом работы влейте свежий `main` в свою ветку.
- `.env`, `data/`, PDF и базы SQLite в Git не попадают. Перед пушем проверьте, что в ветке нет подписанных ссылок:

```bash
git grep -nE "sig=|powerplatform\.com" $(git rev-parse --abbrev-ref HEAD) -- . ':!AGENTS.md' ':!README.md'
```
