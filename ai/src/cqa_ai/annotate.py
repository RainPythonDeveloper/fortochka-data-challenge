"""Facts derived from service events, computed in code so the model does not have to.

The transcript text stays untouched. This module only reads system events and
marks what they imply: where the client could not hear the operator, where the
recording was interrupted, and how the conversation ended. Nothing here knows
about a specific checklist.
"""

from __future__ import annotations

import re

from pydantic import BaseModel, Field

from cqa_ai.contracts import ConversationSnapshot, Turn, TurnRange

_HOLD_END = ("больше не находится на удержании", "no longer on hold")
_HOLD_START = ("находится на удержании", "is on hold")
_RECORDING_PAUSE = ("запись и транскрибирование приостановлены", "recording paused")
_RECORDING_RESUME = ("запись и транскрибирование возобновлены", "recording resumed")
_IDENTITY = (
    "личность клиента подтверждена",
    "customer identity verified",
    "жеке басы расталды",
)
_END_EVENTS = {
    "operator_closed": ("оператор закрыл чат", "agent closed the chat", "оператор чатты жапты"),
    "client_left": ("клиент покинул чат", "customer left the chat", "клиент чаттан шықты"),
    "connection_lost": (
        "соединение с клиентом прервано",
        "connection to customer lost",
        "клиентпен байланыс үзілді",
    ),
    "client_ended_call": ("клиент завершил разговор",),
}

_ESCALATION = (
    "эскалация на оператора",
    "переведен на оператора",
    "переведён на оператора",
    "операторға жіберілді",
    "transferred to an agent",
    "transferred to an operator",
)

# Lexical hints. They only point the model at turns worth checking; the model decides.
_GREETINGS = (
    "здравствуйте", "добрый день", "добрый вечер", "доброе утро", "приветствую", "привет",
    "сәлеметсіз", "сәлем", "қайырлы", "hello", "hi,", "hi ", "hi!", "good morning",
    "good afternoon", "good evening", "greetings",
)
_INFORMAL_GREETING = re.compile(r"^\s*(привет|сәлем|hey)(?![а-яёәғқңөұүһіa-z])", re.IGNORECASE)
_NAME_PHRASE = re.compile(
    r"(меня зовут|моё имя|мое имя|менің атым|атым\s|my name is|\[имя скрыто\])", re.IGNORECASE
)
# A pronoun followed by a capitalised word: "Я Лера", "мен Дана", "I'm Maya", "this is Sam".
_NAME_PRONOUN = re.compile(
    r"(?:\b[Яя]|\b[Мм]ен|\b[Ii]['’]?m|\b[Ii] am|\b[Tt]his is)\s+"
    r"([A-ZА-ЯЁӘҒҚҢӨҰҮҺІ][a-zа-яёәғқңөұүһі]+)"
)
# Capitalised words after a pronoun that are not names ("Я Вас понял", "I'm Sorry").
_NOT_NAMES = {
    "вас", "вам", "вами", "ваш", "вашу", "сізге", "сізді", "сіз", "сіздің", "сорри",
    "sorry", "afraid", "glad", "happy", "here", "freedom", "support", "the", "not", "going",
}
_WAIT = (
    "подождите", "ожидайте", "минуту", "минутку", "секунду", "сейчас проверю", "уточню",
    "проверю", "күте тұрыңыз", "күтіңіз", "минут", "тексеремін", "тексеріп",
    "please wait", "one moment", "a moment", "let me check", "give me a minute", "hold on",
)
_FAREWELL = (
    "до свидания", "всего доброго", "хорошего дня", "хорошего вечера", "всего хорошего",
    "до встречи", "сау болыңыз", "күніңіз сәтті", "кешіңіз сәтті", "goodbye", "bye",
    "have a good", "have a nice", "take care",
)
_HELP_OFFER = (
    "чем ещё", "чем еще", "могу ли я ещё", "остались вопросы", "если вопрос",
    "если возникнут", "обращайтесь", "напишите нам", "тағы сұрақ", "басқа сұрақ",
    "хабарласыңыз", "anything else", "other questions", "feel free", "reach out", "let us know",
)
# Possessive or personal phrasing only: an official paid service, a company hotline or
# a "Telegram bot" must not look like a private deal.
_PERSONAL_CONTACT = re.compile(
    r"(на мою (личную )?карту|мне на карту|мне лично|ваш личный (номер|телефон)"
    r"|личный номер|мой (личный )?(номер|телефон|whatsapp|телеграм|telegram)"
    r"|мне в (whatsapp|telegram|вотсап|телеграм)|после работы (позвоню|наберу|свяжусь)"
    r"|жеке нөмір|жеке картам|менің картам|жұмыстан кейін хабарлас"
    r"|your personal (number|phone)|my (personal )?(card|number|phone|whatsapp|telegram)"
    r"|call you after work|i charge|pay me)",
    re.IGNORECASE,
)
_KZ_LETTERS = set("әғқңөұүһіӘҒҚҢӨҰҮҺІ")


def detect_language(text: str) -> str | None:
    """A rough script-based guess: KZ, RU, EN, or None for too little text."""
    letters = [c for c in text if c.isalpha()]
    if len(letters) < 3:
        return None
    if any(c in _KZ_LETTERS for c in letters):
        return "KZ"
    # Latin menu items and product names inside a Russian reply must not flip it to EN:
    # decide by words, and any run of several Cyrillic words means Russian.
    words = re.findall(r"[^\W\d_]{2,}", text)
    cyrillic_words = sum(1 for w in words if re.search(r"[а-яё]", w, re.IGNORECASE))
    if cyrillic_words >= 3 or (words and cyrillic_words >= len(words) / 2):
        return "RU"
    return "EN"


def _seconds(timestamp: str) -> int | None:
    match = re.fullmatch(r"(\d+):(\d{2})", timestamp.strip())
    return int(match.group(1)) * 60 + int(match.group(2)) if match else None


_END_LABELS = {
    "operator_closed": "оператор закрыл чат",
    "client_left": "клиент покинул чат",
    "connection_lost": "связь с клиентом оборвалась",
    "client_ended_call": "клиент завершил звонок",
}


class ConversationFacts(BaseModel):
    first_operator_turn: int | None = None
    last_operator_turn: int | None = None
    end_event: str | None = None
    end_event_turn: int | None = None
    identity_confirmed_turns: list[int] = Field(default_factory=list)
    hold_ranges: list[TurnRange] = Field(default_factory=list)
    recording_gaps: list[TurnRange] = Field(default_factory=list)
    # W6: lexical observations. Hints for the model, never decisions.
    escalation_turn: int | None = None
    client_turns_before_operator: list[int] = Field(default_factory=list)
    client_turns_while_waiting: list[int] = Field(default_factory=list)
    first_operator_has_greeting: bool | None = None
    first_operator_greeting_informal: bool = False
    first_operator_has_name: bool | None = None
    client_language: str | None = None
    first_operator_language: str | None = None
    operator_wait_turns: list[int] = Field(default_factory=list)
    long_pauses: list[TurnRange] = Field(default_factory=list)
    personal_contact_turns: list[int] = Field(default_factory=list)
    last_operator_has_farewell: bool | None = None
    last_operator_offers_help: bool | None = None

    def is_internal(self, index: int) -> bool:
        """True for turns spoken while the client was on hold."""
        return any(r.from_turn < index < r.to_turn for r in self.hold_ranges)


def _matches(text: str, patterns: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return any(pattern in lowered for pattern in patterns)


def annotate(snapshot: ConversationSnapshot) -> ConversationFacts:
    facts = ConversationFacts()
    last_index = snapshot.turns[-1].index if snapshot.turns else 0
    hold_start: int | None = None
    gap_start: int | None = None

    for turn in snapshot.turns:
        if turn.speaker != "system":
            continue
        if _matches(turn.text, _HOLD_END):
            if hold_start is not None:
                facts.hold_ranges.append(TurnRange(from_turn=hold_start, to_turn=turn.index))
                hold_start = None
        elif _matches(turn.text, _HOLD_START):
            hold_start = turn.index
        elif _matches(turn.text, _RECORDING_PAUSE):
            gap_start = turn.index
        elif _matches(turn.text, _RECORDING_RESUME):
            if gap_start is not None:
                facts.recording_gaps.append(TurnRange(from_turn=gap_start, to_turn=turn.index))
                gap_start = None
        elif _matches(turn.text, _ESCALATION):
            if facts.escalation_turn is None:
                facts.escalation_turn = turn.index
        elif _matches(turn.text, _IDENTITY):
            facts.identity_confirmed_turns.append(turn.index)
        else:
            for kind, patterns in _END_EVENTS.items():
                if _matches(turn.text, patterns):
                    facts.end_event = kind
                    facts.end_event_turn = turn.index
                    break

    if hold_start is not None:
        facts.hold_ranges.append(TurnRange(from_turn=hold_start, to_turn=last_index + 1))
    if gap_start is not None:
        facts.recording_gaps.append(TurnRange(from_turn=gap_start, to_turn=last_index + 1))

    operator_turns = [
        t.index
        for t in snapshot.turns
        if t.speaker == "operator" and not facts.is_internal(t.index)
    ]
    if operator_turns:
        facts.first_operator_turn = operator_turns[0]
        facts.last_operator_turn = operator_turns[-1]
    _lexical_facts(snapshot, facts)
    return facts


def _lexical_facts(snapshot: ConversationSnapshot, facts: ConversationFacts) -> None:
    turns = {t.index: t for t in snapshot.turns}
    first = facts.first_operator_turn
    if first is not None:
        for t in snapshot.turns:
            if t.index >= first:
                break
            if t.speaker != "client":
                continue
            if facts.escalation_turn is not None and t.index > facts.escalation_turn:
                facts.client_turns_while_waiting.append(t.index)
            else:
                facts.client_turns_before_operator.append(t.index)
        text = turns[first].text
        lowered = text.lower()
        facts.first_operator_has_greeting = any(g in lowered for g in _GREETINGS)
        facts.first_operator_greeting_informal = bool(_INFORMAL_GREETING.match(text))
        facts.first_operator_has_name = bool(_NAME_PHRASE.search(text)) or any(
            m.group(1).lower() not in _NOT_NAMES for m in _NAME_PRONOUN.finditer(text)
        )
        facts.first_operator_language = detect_language(text)
    client_text = " ".join(t.text for t in snapshot.turns if t.speaker == "client")
    facts.client_language = detect_language(client_text)

    previous: int | None = None
    previous_index: int | None = None
    for t in snapshot.turns:
        if t.speaker == "operator" and not facts.is_internal(t.index):
            lowered = t.text.lower()
            if any(w in lowered for w in _WAIT):
                facts.operator_wait_turns.append(t.index)
            if _PERSONAL_CONTACT.search(t.text):
                facts.personal_contact_turns.append(t.index)
        if t.speaker in ("operator", "client"):
            current = _seconds(t.timestamp)
            if current is None:
                continue
            if previous is not None and previous_index is not None and current - previous > 180:
                facts.long_pauses.append(TurnRange(from_turn=previous_index, to_turn=t.index))
            previous, previous_index = current, t.index

    last = facts.last_operator_turn
    if last is not None:
        lowered = turns[last].text.lower()
        facts.last_operator_has_farewell = any(w in lowered for w in _FAREWELL)
        facts.last_operator_offers_help = any(w in lowered for w in _HELP_OFFER)


def _yes_no(value: bool | None) -> str:
    return "да" if value else "нет"


def render_facts(facts: ConversationFacts) -> str:
    lines: list[str] = []
    if facts.first_operator_turn is None:
        lines.append("Оператор в разговоре не участвовал.")
    else:
        lines.append(f"Первая реплика оператора клиенту: [{facts.first_operator_turn}].")
        lines.append(f"Последняя реплика оператора клиенту: [{facts.last_operator_turn}].")
    if facts.identity_confirmed_turns:
        joined = ", ".join(f"[{i}]" for i in facts.identity_confirmed_turns)
        lines.append(f"Система подтвердила личность клиента: {joined}.")
    if facts.end_event:
        label = _END_LABELS[facts.end_event]
        lines.append(f"Событие завершения: {label}, [{facts.end_event_turn}].")
    for hold in facts.hold_ranges:
        lines.append(
            f"Клиент на удержании между [{hold.from_turn}] и [{hold.to_turn}]. "
            "Реплики внутри помечены как внутренние: клиент их не слышал."
        )
    for gap in facts.recording_gaps:
        lines.append(
            f"Запись прервана между [{gap.from_turn}] и [{gap.to_turn}]. "
            "Что происходило в разрыве, неизвестно. Это не молчание."
        )
    if facts.escalation_turn is not None:
        lines.append(f"Разговор передан оператору: [{facts.escalation_turn}].")
    if facts.client_turns_before_operator:
        joined = ", ".join(f"[{i}]" for i in facts.client_turns_before_operator)
        lines.append(f"Клиент писал до подключения оператора, оператор это видит: {joined}.")
    if facts.client_turns_while_waiting:
        joined = ", ".join(f"[{i}]" for i in facts.client_turns_while_waiting)
        lines.append(f"Клиент писал, пока ждал оператора, их легко пропустить: {joined}.")
    return "\n".join(f"- {line}" for line in lines)


def render_hints(facts: ConversationFacts) -> str:
    """Lexical observations. They can be wrong; the model must check the text."""
    lines: list[str] = []
    if facts.first_operator_turn is not None:
        informal = ", неформальное" if facts.first_operator_greeting_informal else ""
        lines.append(
            f"В первой реплике оператора [{facts.first_operator_turn}] словарь нашёл: "
            f"приветствие — {_yes_no(facts.first_operator_has_greeting)}{informal}, "
            f"представление по имени — {_yes_no(facts.first_operator_has_name)}."
        )
        if facts.client_language and facts.first_operator_language:
            lines.append(
                f"Язык по алфавиту: клиент {facts.client_language}, "
                f"первая реплика оператора {facts.first_operator_language}."
            )
    if facts.operator_wait_turns:
        joined = ", ".join(f"[{i}]" for i in facts.operator_wait_turns)
        lines.append(f"Оператор просит подождать или берёт паузу: {joined}.")
    for pause in facts.long_pauses:
        lines.append(f"Пауза больше 3 минут между [{pause.from_turn}] и [{pause.to_turn}].")
    if facts.personal_contact_turns:
        joined = ", ".join(f"[{i}]" for i in facts.personal_contact_turns)
        lines.append(f"Реплики оператора о личных контактах, картах или оплате: {joined}.")
    if facts.last_operator_turn is not None:
        # Only what was found: a summary cannot be detected by words, so an absent
        # help offer says nothing and must not push towards "no".
        found = []
        if facts.last_operator_has_farewell:
            found.append("прощание")
        if facts.last_operator_offers_help:
            found.append("предложение дальнейшей помощи")
        if found:
            lines.append(
                f"В последней реплике оператора [{facts.last_operator_turn}] словарь нашёл: "
                + ", ".join(found)
                + ". Итог разговора словарём не проверяется."
            )
        else:
            lines.append(
                f"В последней реплике оператора [{facts.last_operator_turn}] словарь "
                "не нашёл прощания."
            )
    return "\n".join(f"- {line}" for line in lines)


def _short_time(timestamp: str) -> str:
    return timestamp[11:19] if "T" in timestamp else timestamp


def render_turn(turn: Turn, facts: ConversationFacts) -> str:
    scope = " (внутренняя реплика, клиент не слышит)" if facts.is_internal(turn.index) else ""
    return f"[{turn.index}] {turn.speaker}{scope} {_short_time(turn.timestamp)}: {turn.text}"
