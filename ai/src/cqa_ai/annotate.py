"""Facts derived from service events, computed in code so the model does not have to.

The transcript text stays untouched. This module only reads system events and
marks what they imply: where the client could not hear the operator, where the
recording was interrupted, and how the conversation ended. Nothing here knows
about a specific checklist.
"""

from __future__ import annotations

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
    return facts


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
    return "\n".join(f"- {line}" for line in lines)


def _short_time(timestamp: str) -> str:
    return timestamp[11:19] if "T" in timestamp else timestamp


def render_turn(turn: Turn, facts: ConversationFacts) -> str:
    scope = " (внутренняя реплика, клиент не слышит)" if facts.is_internal(turn.index) else ""
    return f"[{turn.index}] {turn.speaker}{scope} {_short_time(turn.timestamp)}: {turn.text}"
