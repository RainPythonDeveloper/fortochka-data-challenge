"""W6: lexical facts on synthetic dialogues only."""

from __future__ import annotations

import pytest

from cqa_ai.annotate import annotate, detect_language, render_hints
from cqa_ai.contracts import ConversationSnapshot, Turn


def snap(*turns: tuple[str, str, str], language: str = "RU") -> ConversationSnapshot:
    return ConversationSnapshot(
        conversation_id="syn",
        channel="agent chat",
        language=language,
        turns=[
            Turn(index=i, timestamp=ts, speaker=speaker, text=text)
            for i, (ts, speaker, text) in enumerate(turns)
        ],
    )


def test_escalation_and_client_turns_before_and_while_waiting():
    facts = annotate(
        snap(
            ("00:00", "client", "Где тариф?"),
            ("00:01", "bot", "Здравствуйте! Я бот."),
            ("00:10", "system", "Эскалация на оператора."),
            ("00:20", "client", "И ещё про комиссию"),
            ("00:40", "operator", "Здравствуйте, меня зовут Ада."),
        )
    )
    assert facts.escalation_turn == 2
    assert facts.client_turns_before_operator == [0]
    assert facts.client_turns_while_waiting == [3]
    assert facts.first_operator_turn == 4
    assert facts.first_operator_has_greeting and facts.first_operator_has_name


@pytest.mark.parametrize(
    ("text", "greeting", "name", "informal"),
    [
        ("Здравствуйте, я Лера.", True, True, False),
        ("Привет, где ищете?", True, False, True),
        ("Сәлеметсіз бе, мен Дана.", True, True, False),
        ("Сәлем. Қай сайт?", True, False, True),
        ("Hi, I'm Maya from support.", True, True, False),
        ("Open settings and log in again.", False, False, False),
        ("Добрый день! Меня зовут Вера.", True, True, False),
    ],
)
def test_first_operator_greeting_and_name(text, greeting, name, informal):
    facts = annotate(snap(("00:00", "client", "Помогите"), ("00:05", "operator", text)))
    assert facts.first_operator_has_greeting is greeting
    assert facts.first_operator_has_name is name
    assert facts.first_operator_greeting_informal is informal


def test_language_detection():
    assert detect_language("Сәлеметсіз бе, шотым қайда?") == "KZ"
    assert detect_language("Где мой тариф?") == "RU"
    assert detect_language("Where is my tariff?") == "EN"
    assert detect_language("ok") is None


def test_wait_pause_contact_and_closing_hints():
    facts = annotate(
        snap(
            ("00:00", "client", "Вопрос"),
            ("00:10", "operator", "Здравствуйте, я Ян. Минуту, проверю."),
            ("04:30", "operator", "Скиньте деньги мне на карту, вложу сам."),
            ("05:00", "client", "Нет"),
            ("05:10", "operator", "Если вопросы останутся, обращайтесь. До свидания!"),
        )
    )
    assert facts.operator_wait_turns == [1]
    assert [(p.from_turn, p.to_turn) for p in facts.long_pauses] == [(1, 2)]
    assert facts.personal_contact_turns == [2]
    assert facts.last_operator_has_farewell is True
    assert facts.last_operator_offers_help is True
    hints = render_hints(facts)
    assert "[2]" in hints and "Пауза больше 3 минут" in hints


def test_hold_turns_are_not_scanned_as_client_messages():
    facts = annotate(
        snap(
            ("00:00", "client", "Вопрос"),
            ("00:05", "operator", "Здравствуйте, я Ян."),
            ("00:10", "system", "Клиент находится на удержании"),
            ("00:20", "operator", "Коллега, скинь мне на карту"),
            ("00:30", "system", "Клиент больше не находится на удержании"),
            ("00:40", "operator", "До свидания"),
        )
    )
    assert facts.personal_contact_turns == []


def test_missing_farewell_is_not_reported_for_calls():
    facts = annotate(
        snap(("00:00", "client", "Вопрос"), ("00:05", "operator", "Здравствуйте, я Ян. Ответ такой."))
    )
    assert "не нашёл прощания" in render_hints(facts)
    assert "не нашёл прощания" not in render_hints(facts, "voice call")
