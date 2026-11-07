"""Synthetic dialogues only. Real calls never enter the test suite."""

import json

import pytest

from cqa_ai import load_default_checklists, snapshot_from_record


def turn(speaker, text, timestamp="00:01"):
    return {"timestamp": timestamp, "speaker": speaker, "text": text}


@pytest.fixture
def chat():
    return snapshot_from_record(
        {
            "conversation_id": "synthetic-chat",
            "channel": "agent chat",
            "language": "RU",
            "transcript": [
                turn("client", "Где посмотреть тариф?"),
                turn("bot", "Здравствуйте! Я бот."),
                turn("system", "Эскалация на оператора."),
                turn("client", "Я с телефона."),
                turn("operator", "Здравствуйте, меня зовут Анна. Откройте кабинет."),
                turn("client", "Нашла."),
                turn("operator", "Хорошего дня!"),
            ],
            "audio_url": None,
        }
    )


@pytest.fixture
def call():
    return snapshot_from_record(
        {
            "conversation_id": "synthetic-call",
            "channel": "voice call",
            "language": "RU",
            "transcript": [
                turn("system", "Запись и транскрибирование приостановлены."),
                turn("system", "Запись и транскрибирование возобновлены."),
                turn("operator", "Здравствуйте, [Имя скрыто], слушаю вас."),
                turn("operator", "Ожидайте на линии."),
                turn("system", "Клиент находится на удержании."),
                turn("operator", "Коллега, подскажи по бумаге."),
                turn("system", "Клиент больше не находится на удержании."),
                turn("operator", "Спасибо за ожидание."),
                turn("system", "Клиент завершил разговор."),
                turn("operator", "Остались вопросы?"),
            ],
            "audio_url": "https://example.test/audio?sig=fake",
        }
    )


@pytest.fixture
def checklist():
    return load_default_checklists()[0]


def model_reply(checklist, overrides=None, drop=()):
    """A valid model reply for the given checklist, as the provider would return it."""
    overrides = overrides or {}
    items = []
    for criterion in checklist.criteria:
        if criterion.id in drop:
            continue
        answer = str(criterion.max_level) if criterion.levels else "yes"
        if criterion.flag:
            answer = "no"
        item = {
            "criterion_id": criterion.id,
            "analysis": "Коротко.",
            "answer": answer,
            "justification": "Обоснование.",
            "evidence": [{"turn_index": 4, "quote": "меня зовут Анна"}],
            "reviewed_from_turn": -1,
            "reviewed_to_turn": -1,
            "expected_at_turn": -1,
            "review_flags": [],
        }
        item.update(overrides.get(criterion.id, {}))
        items.append(item)
    return json.dumps({"results": items}, ensure_ascii=False)
