import asyncio
import csv
import json

import httpx
import pytest
from cqa_ai.contracts import ResultStatus
from conftest import AUDIO_URL, CountingEvaluator, make_payload, make_record

from cqa_backend import checklists
from cqa_backend.control import (
    ControlError,
    ControlOptions,
    check_outside_git,
    format_report,
    main,
    parse_args,
    run_control,
)
from cqa_backend.db import Database
from cqa_backend.errors import ApiError

IDS = [f"ctl-{index:02d}" for index in range(10)]


def transport(records, group="CTRL"):
    payload = make_payload(records, group)
    return httpx.MockTransport(lambda _: httpx.Response(200, json=payload))


def options(tmp_path, **extra):
    base = {
        "group_id": "CTRL", "allow_mock": True, "retry_delay_s": 0, "out_dir": tmp_path / "out",
    }
    return ControlOptions(**{**base, **extra})


def control(settings, opts, records=None, evaluator=None):
    records = [make_record(item) for item in IDS] if records is None else records
    return asyncio.run(run_control(settings, opts, evaluator, transport(records)))


def test_control_run_writes_complete_exports(settings, tmp_path):
    report = control(settings, options(tmp_path), evaluator=CountingEvaluator())

    assert report.ok and report.complete == IDS and report.rounds == 1 and report.runs == 10
    export = json.loads(report.json_path.read_text(encoding="utf-8"))
    assert export["done"] == 10 and export["failed"] == 0
    with report.csv_path.open(encoding="utf-8") as handle:
        assert [row["conversation_id"] for row in csv.DictReader(handle)] == sorted(IDS)
    text = format_report(report)
    assert "10 из 10" in text and "ГОТОВО" in text
    assert "freedom-chat-quality v1" in text


def test_only_failed_dialogues_are_retried(settings, tmp_path):
    evaluator = CountingEvaluator(fail_for={"ctl-03"})

    async def heal_after_two(snapshot, checklist, config):
        if evaluator.calls.count("ctl-03") == 2:
            evaluator.fail_for = set()
        return await evaluator(snapshot, checklist, config)

    report = control(settings, options(tmp_path), evaluator=heal_after_two)

    assert report.ok and report.rounds == 3
    assert evaluator.calls.count("ctl-03") == 3
    assert all(evaluator.calls.count(item) == 1 for item in IDS if item != "ctl-03")


def test_retry_limit_leaves_failure_visible_and_masked(settings, tmp_path):
    evaluator = CountingEvaluator(fail_for={"ctl-03"})
    report = control(settings, options(tmp_path, max_retries=1), evaluator=evaluator)

    assert not report.ok and list(report.incomplete) == ["ctl-03"]
    assert evaluator.calls.count("ctl-03") == 2
    export = json.loads(report.json_path.read_text(encoding="utf-8"))
    assert export["failed"] == 1
    assert next(i for i in export["results"] if i["status"] == "failed")["total"] is None
    text = format_report(report)
    assert "НЕ ГОТОВО" in text and "AUDIOSIGNATURE123" not in text
    assert "AUDIOSIGNATURE123" not in report.json_path.read_text(encoding="utf-8")


def test_partial_result_is_incomplete(settings, tmp_path):
    async def partial(snapshot, checklist, config):
        output = await CountingEvaluator()(snapshot, checklist, config)
        output.results = output.results[1:]
        return output

    report = control(settings, options(tmp_path, max_retries=0), evaluator=partial)
    assert not report.ok and len(report.incomplete) == 10
    assert "c01" in report.incomplete["ctl-00"]


def test_wrong_count_stops_before_anything_is_stored(settings, tmp_path):
    with pytest.raises(ControlError, match="записей 9"):
        control(settings, options(tmp_path), [make_record(item) for item in IDS[:9]])
    with Database(settings.cqa_db_path).read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0] == 0


def test_expected_count_is_a_parameter(settings, tmp_path):
    report = control(
        settings, options(tmp_path, expected_records=2), [make_record("a"), make_record("b")]
    )
    assert report.ok


def test_duplicates_and_broken_records_stop_the_run(settings, tmp_path):
    records = [make_record(item) for item in IDS]
    records[1] = make_record(IDS[0])
    with pytest.raises(ControlError, match="повторный"):
        control(settings, options(tmp_path), records)

    records = [make_record(item) for item in IDS]
    records[2] = {"conversation_id": "x", "audio_url": AUDIO_URL}
    with pytest.raises(ControlError) as caught:
        control(settings, options(tmp_path), records)
    assert "AUDIOSIGNATURE123" not in str(caught.value)


def test_wrong_group_stops_the_run(settings, tmp_path):
    payload = make_payload([make_record(item) for item in IDS], "OTHER")
    wrong = httpx.MockTransport(lambda _: httpx.Response(200, json=payload))
    with pytest.raises(ControlError, match="dataset_group_id"):
        asyncio.run(run_control(settings, options(tmp_path), None, wrong))


def test_mock_needs_its_own_flag(settings, tmp_path):
    with pytest.raises(ControlError, match="--allow-mock"):
        control(settings, options(tmp_path, allow_mock=False))


def test_warnings_reach_the_report(settings, tmp_path):
    records = [make_record(item, new_field=1) for item in IDS]
    report = control(settings, options(tmp_path), records)
    assert report.ok and "new_field" in format_report(report)


def test_cost_is_summed_over_retries(settings, tmp_path):
    state = {"failed": False}
    inner = CountingEvaluator()

    async def priced(snapshot, checklist, config):
        output = await inner(snapshot, checklist, config)
        output.attempts[0].cost_usd = 0.1
        if snapshot.conversation_id == "ctl-00" and not state["failed"]:
            state["failed"] = True
            for result in output.results:
                result.status, result.answer = ResultStatus.FAILED, None
                result.justification = "rate limit"
        return output

    report = control(settings, options(tmp_path), evaluator=priced)
    assert report.ok and report.rounds == 2
    assert report.cost_usd == pytest.approx(1.1) and report.runs == 11


def test_free_api_cost_is_zero_and_not_unknown(settings, tmp_path):
    async def free(snapshot, checklist, config):
        output = await CountingEvaluator()(snapshot, checklist, config)
        output.attempts[0].cost_usd = 0
        return output

    report = control(settings, options(tmp_path), evaluator=free)
    assert report.cost_usd == 0 and report.runs_without_cost == 0
    assert "$0.0000" in format_report(report)


def test_cost_gap_is_reported(settings, tmp_path):
    async def mixed(snapshot, checklist, config):
        output = await CountingEvaluator()(snapshot, checklist, config)
        output.attempts[0].cost_usd = None if snapshot.conversation_id == "ctl-00" else 0.1
        return output

    report = control(settings, options(tmp_path), evaluator=mixed)
    assert report.runs_without_cost == 1 and "без учёта 1" in format_report(report)


def add_checklist(settings, checklist_id, channels):
    db = Database(settings.cqa_db_path)
    checklists.seed_defaults(db)
    body = checklists.list_checklists(db)[0].checklist_id
    base = checklists.get_checklist(db, body).model_dump(mode="json")
    checklists.create_checklist(db, {**base, "checklist_id": checklist_id, "channels": channels})


def test_mixed_channels_with_assignment_and_report(settings, tmp_path):
    add_checklist(settings, "voice-a", ["voice call"])
    add_checklist(settings, "voice-b", ["voice call"])
    records = [make_record("chat"), make_record("call", channel="voice call")]
    opts = options(
        tmp_path, expected_records=2, checklists_by_channel={"voice call": "voice-b"}
    )

    report = control(settings, opts, records)

    assert report.ok
    assert report.checklists == ["freedom-chat-quality v1", "voice-b v1"]
    assert "voice-b v1" in format_report(report)


def test_ambiguous_channel_stops_the_run_with_a_clear_reason(settings, tmp_path):
    add_checklist(settings, "other-a", ["web form"])
    add_checklist(settings, "other-b", ["web form"])
    records = [make_record("call", channel="web form")]
    with pytest.raises(ApiError, match="checklists_by_channel"):
        control(settings, options(tmp_path, expected_records=1), records)


def test_checklist_for_argument():
    parsed = parse_args(
        ["--group-id", "G", "--checklist-for", "voice call=v=1", "--checklist-for", "agent chat=c"]
    )
    assert parsed.checklists_by_channel == {"voice call": "v=1", "agent chat": "c"}
    assert parse_args(["--group-id", "G"]).checklists_by_channel is None
    for bad in (
        ["--checklist-for", "voice call"],
        ["--checklist-for", "=x"],
        ["--checklist-for", "a=b", "--checklist-id", "c"],
    ):
        with pytest.raises(SystemExit):
            parse_args(["--group-id", "G", *bad])


def test_out_dir_inside_git_is_refused(tmp_path):
    import subprocess

    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    (tmp_path / ".gitignore").write_text("data/\n", encoding="utf-8")
    check_outside_git(tmp_path / "data" / "x")
    with pytest.raises(ControlError, match="Git"):
        check_outside_git(tmp_path / "tracked" / "x")


def test_cli_stops_with_a_masked_reason(monkeypatch, capsys, tmp_path):
    for name in ("LLM_PROVIDER", "LLM_MODEL", "CQA_ALLOW_MOCK"):
        monkeypatch.setenv(name, "")
    monkeypatch.setenv("CQA_DB_PATH", str(tmp_path / "x.sqlite"))
    code = main(["--group-id", "CTRL", "--out-dir", str(tmp_path / "out")])
    assert code == 2
    assert "LLM_PROVIDER" in capsys.readouterr().err


def test_control_writes_the_submission_file(settings, tmp_path):
    target = tmp_path / "results" / "prod" / "results.json"
    report = control(settings, options(tmp_path, results_file=target), evaluator=CountingEvaluator())

    data = json.loads(target.read_text(encoding="utf-8"))
    assert report.ok and report.results_path == target
    assert len(data["results"]) == 10 and all(item["status"] == "ok" for item in data["results"])
    assert not [item for item in report.warnings if item.startswith("results.json")]
    assert f"Файл для сдачи: {target}" in format_report(report)
    assert parse_args(["--group-id", "X", "--results-file", "r.json"]).results_file.name == "r.json"
