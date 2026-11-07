import json
import re

import pytest

from cqa_ai import checklist_hash, load_default_checklists
from cqa_ai.annotate import annotate, render_facts, render_turn
from cqa_ai.contracts import Criterion, CriterionType, EvaluatorConfig, ScaleLevel
from cqa_ai.prompt import build_prompt, prompt_version
from cqa_ai.rubric import effective_notes, meaning_fingerprint, render_rubric, response_schema


def test_annotate_marks_hold_gap_identity_and_end(call):
    facts = annotate(call)
    assert [(r.from_turn, r.to_turn) for r in facts.hold_ranges] == [(4, 6)]
    assert [(r.from_turn, r.to_turn) for r in facts.recording_gaps] == [(0, 1)]
    assert facts.is_internal(5) and not facts.is_internal(4) and not facts.is_internal(6)
    assert facts.end_event == "client_ended_call" and facts.end_event_turn == 8
    assert facts.first_operator_turn == 2
    assert facts.last_operator_turn == 9


def test_internal_turns_are_labelled_for_the_model(call):
    facts = annotate(call)
    assert "внутренняя реплика" in render_turn(call.turns[5], facts)
    assert "внутренняя реплика" not in render_turn(call.turns[3], facts)
    assert "Это не молчание" in render_facts(facts)


def test_unknown_system_text_changes_nothing(chat):
    facts = annotate(chat)
    assert facts.end_event is None and not facts.hold_ranges
    assert facts.first_operator_turn == 4


def test_every_default_criterion_has_team_notes():
    for checklist in load_default_checklists():
        for criterion in checklist.criteria:
            assert effective_notes(criterion), criterion.id


def test_each_channel_has_exactly_one_default_checklist():
    channels = [c for checklist in load_default_checklists() for c in checklist.channels]
    assert sorted(channels) == ["agent chat", "voice call"]


def test_rewording_drops_inherited_notes_but_keeps_new_ones(checklist):
    original = checklist.criteria[6]
    reworded = original.model_copy(deep=True)
    reworded.yes_when = "Оператор просто попрощался."
    assert meaning_fingerprint(reworded) != meaning_fingerprint(original)
    assert effective_notes(reworded) == []

    reworded.team_notes = [*original.team_notes, "Новая заметка человека."]
    assert effective_notes(reworded) == ["Новая заметка человека."]


def test_a_note_written_in_the_ui_comes_last_and_can_override(checklist):
    criterion = checklist.criteria[6].model_copy(deep=True)
    criterion.team_notes = [*criterion.team_notes, "Простое прощание считать достаточным."]
    assert effective_notes(criterion)[-1] == "Простое прощание считать достаточным."
    assert len(effective_notes(criterion)) == 3


def test_changing_only_a_weight_keeps_the_prompt(checklist, chat):
    reweighted = checklist.model_copy(deep=True)
    reweighted.criteria[0].weight = 40
    facts = annotate(chat)
    first = build_prompt(chat, checklist, facts)
    second = build_prompt(chat, reweighted, facts)
    assert first.system == second.system and first.prompt_hash == second.prompt_hash
    assert checklist_hash(checklist) == checklist_hash(reweighted)


def test_a_replaced_criterion_reaches_prompt_and_schema(checklist, chat):
    replaced = checklist.model_copy(deep=True)
    replaced.criteria[1] = Criterion(
        id="c09",
        section="s1",
        title="Новый критерий",
        type=CriterionType.SCALE,
        weight=15,
        prompt="Оцените новое условие.",
        levels=[ScaleLevel(value=3, text="Хорошо"), ScaleLevel(value=0, text="Плохо")],
    )
    prompt = build_prompt(chat, replaced, annotate(chat))
    assert "c09. Новый критерий" in prompt.system and "Оцените новое условие" in prompt.system
    assert "c02." not in prompt.system
    schema = response_schema(replaced)
    item = schema["properties"]["results"]["items"]["properties"]
    assert "c09" in item["criterion_id"]["enum"] and "3" in item["answer"]["enum"]


def test_prompt_never_contains_the_conversation_id(chat, checklist):
    prompt = build_prompt(chat, checklist, annotate(chat))
    assert chat.conversation_id not in prompt.system + prompt.user


def test_transcript_goes_only_into_the_user_part(chat, checklist):
    prompt = build_prompt(chat, checklist, annotate(chat))
    assert "меня зовут Анна" in prompt.user and "меня зовут Анна" not in prompt.system


def test_voice_rules_appear_only_for_calls(chat, call, checklist):
    assert "speech recognition" not in build_prompt(chat, checklist, annotate(chat)).system
    voice = load_default_checklists()[1]
    assert "speech recognition" in build_prompt(call, voice, annotate(call)).system


def test_rubric_text_hides_weights_and_keeps_official_wording(checklist):
    text = render_rubric(checklist)
    assert not re.search(r"\bвес\b", text.lower())
    assert "Оператор подвёл итог или предложил дальнейшую помощь и попрощался." in text


def test_schema_has_no_unions_and_is_closed(checklist):
    encoded = json.dumps(response_schema(checklist))
    assert "anyOf" not in encoded and "oneOf" not in encoded
    item = response_schema(checklist)["properties"]["results"]["items"]
    assert item["additionalProperties"] is False
    assert set(item["required"]) == set(item["properties"])


def test_prompt_version_is_part_of_the_cache_key():
    config = EvaluatorConfig(provider="nvidia", model="m")
    assert config.prompt_version == prompt_version()
    assert prompt_version() in config.model_dump_json()


@pytest.mark.parametrize("index", [0, 1])
def test_default_checklists_weigh_one_hundred(index):
    checklist = load_default_checklists()[index]
    assert sum(c.weight for c in checklist.criteria) == 100
