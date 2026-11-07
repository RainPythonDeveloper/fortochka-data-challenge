import asyncio
import csv
import json

import httpx
import pytest
from conftest import AUDIO_URL, CountingEvaluator, make_payload, make_record

from cqa_backend.control import (
    ControlError,
    ControlOptions,
    check_outside_git,
    format_report,
    main,
    run_control,
)
from cqa_backend.db import Database

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
        if snapshot.conversation_id == "ctl-00" and not state["failed"]:
            state["failed"] = True
            raise RuntimeError("rate limit")
        output = await inner(snapshot, checklist, config)
        output.attempts[0].cost_usd = 0.1
        return output

    report = control(settings, options(tmp_path), evaluator=priced)
    assert report.ok and report.cost_usd == pytest.approx(1.0)
    assert report.runs == 11 and report.runs_without_cost == 1
    assert "без учёта 1" in format_report(report)


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
