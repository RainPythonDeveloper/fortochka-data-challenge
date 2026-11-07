"""Builds a detailed three-model comparison from bench runs.

Usage (from fortochka/ai):
    uv run python tools/compare_models.py > ../docs/MODEL_COMPARISON_DATA.md

Reads only local run files and the reference labels. Real call text is never printed:
the comparison covers chats only.
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

from cqa_ai import calculate_score, load_default_checklists
from cqa_ai.contracts import CriterionResult, ResultStatus
from cqa_ai.evaluation.metrics import _value, label_results, label_value
from cqa_ai.rubric import NA_ANSWER

ROOT = Path(__file__).resolve().parents[2] / "data" / "bench"
MODELS = {
    "Nemotron 3 Ultra": [
        "s3-tune-v3/nvidia~nvidia_nemotron-3-ultra-550b-a55b__single__r1",
        "s4-compare-A/nvidia~nvidia_nemotron-3-ultra-550b-a55b__single__r1",
    ],
    "Nemotron 3.5 Super-VL": [
        "s3-tune-v3/nvidia~nvidia_nemotron-3.5-super-vl-120b-a12b__single__r1",
        "s4-compare-B/nvidia~nvidia_nemotron-3.5-super-vl-120b-a12b__single__r1",
    ],
    "Gemma 4 31B": ["s6-gemma-v3/nvidia~google_gemma-4-31b-it__single__r1"],
}
PRICES = {  # USD per 1M tokens, OpenRouter catalog 2026-11-07
    "Nemotron 3 Ultra": (0.60, 2.40),
    "Nemotron 3.5 Super-VL": (0.15, 0.50),
    "Gemma 4 31B": (0.20, 0.40),
}
SCALES = {"c04": [0, 5, 10, 15, 20], "c06": [0, 4, 7, 10]}
CRITERIA = [f"c0{i}" for i in range(1, 9)]
TITLES = {
    "c01": "Установление контакта", "c02": "Выявление потребности", "c03": "Идентификация",
    "c04": "Консультация", "c05": "Эмпатия", "c06": "Управление диалогом",
    "c07": "Завершение", "c08": "Грубые ошибки",
}


def load(paths):
    latest = {}
    for rel in paths:
        f = ROOT / rel / "results.jsonl"
        if not f.exists():
            continue
        for line in f.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if row["channel"] != "agent chat":
                continue
            cid = row["conversation_id"]
            if cid not in latest or not row.get("failed"):
                latest[cid] = row
    return latest


def err_kind(text: str) -> str:
    t = text.lower()
    if "truncated" in t:
        return "ответ обрезан лимитом токенов"
    if "not the required json" in t:
        return "невалидный JSON"
    if "rate limit" in t:
        return "лимит запросов 429"
    if "did not respond" in t or "timed out" in t or "timeout" in t:
        return "таймаут"
    if "server error" in t:
        return "ошибка сервера 5xx"
    if "quote" in t or "does not exist" in t:
        return "цитата не найдена (отброшена)"
    if "not allowed" in t or "missing from the response" in t:
        return "нарушение контракта (ответ/критерий)"
    if "justification is empty" in t or "give evidence" in t:
        return "нет обоснования/доказательства"
    return "прочее"


def pct(n, d):
    return f"{100 * n / d:.0f}%" if d else "—"


def q(values, p):
    if not values:
        return None
    s = sorted(values)
    return round(s[min(len(s) - 1, max(0, round(p * (len(s) - 1))))], 1)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    fortochka = Path(__file__).resolve().parents[2]
    ref = json.loads((fortochka / "ai/labels/reference_v3.json").read_text(encoding="utf-8"))
    labels = ref["labels"]
    checklist = next(c for c in load_default_checklists() if c.checklist_id == ref["checklist_id"])
    runs = {name: load(paths) for name, paths in MODELS.items()}
    all_ids = sorted(set().union(*[set(r) for r in runs.values()]))
    ok_ids = {
        name: {cid for cid, row in r.items() if not row.get("failed")} for name, r in runs.items()
    }
    common = sorted(set.intersection(*ok_ids.values()))
    print(f"Чатов в выборке (tune + compare): {len(all_ids)}; оценены всеми тремя: {len(common)}\n")

    stats = {}
    mismatch = defaultdict(dict)  # (cid, crit) -> {model: (value, justification)}
    for name, r in runs.items():
        s = defaultdict(int)
        s["coverage"] = f"{len(ok_ids[name])}/{len(all_ids)}"
        per_crit = defaultdict(lambda: [0, 0])
        near = defaultdict(lambda: [0, 0])
        lang = defaultdict(lambda: [0, 0, []])
        errors, conf_hi, conf_lo = [], [0, 0], [0, 0]
        model_secs, walls, calls, tin, tout, ev_items, ev_ok, flagged = [], [], [], [], [], [], 0, 0
        err_types = Counter()
        crit_total = 0
        for cid in all_ids:
            row = r.get(cid)
            if row is None:
                continue
            for a in row["attempts"]:
                for e in a.get("errors", []):
                    err_types[err_kind(e)] += 1
            if row.get("failed"):
                continue
            calls.append(len(row["attempts"]))
            tin.append(sum(a.get("input_tokens") or 0 for a in row["attempts"]))
            tout.append(sum(a.get("output_tokens") or 0 for a in row["attempts"]))
            model_secs.append(sum(a.get("latency_ms") or 0 for a in row["attempts"]) / 1000)
            walls.append(row["seconds"])
            if "contract_repair_used" in row.get("review_reasons", []):
                s["repairs"] += 1
            if "served_by_fallback_model" in row.get("review_reasons", []):
                s["fallbacks"] += 1
            if cid not in common:
                continue
            label = labels[cid]
            results = [CriterionResult.model_validate(x) for x in row["results"]]
            by = {x.criterion_id: x for x in results}
            for c in CRITERIA:
                exp, got = label_value(label[c]), _value(by.get(c))
                res = by.get(c)
                if got is None:
                    continue
                crit_total += 1
                if res.evidence:
                    ev_items.append(len(res.evidence))
                if res.evidence or res.reviewed_range or res.expected_at_turn is not None:
                    ev_ok += 1
                if "low_confidence" in res.review_flags:
                    flagged += 1
                hit = got == exp
                per_crit[c][0] += hit
                per_crit[c][1] += 1
                bucket = conf_hi if (res.confidence or 0) >= 0.85 else conf_lo
                bucket[0] += hit
                bucket[1] += 1
                if got == NA_ANSWER and exp != NA_ANSWER:
                    s["false_na"] += 1
                if exp == NA_ANSWER and got != NA_ANSWER:
                    s["missed_na"] += 1
                if c == "c08" and exp == "yes" and got != "yes":
                    s["c08_missed"] += 1
                if c == "c08" and exp == "no" and got == "yes":
                    s["c08_false"] += 1
                if c in SCALES and exp in SCALES[c] and got in SCALES[c]:
                    near[c][1] += 1
                    near[c][0] += abs(SCALES[c].index(exp) - SCALES[c].index(got)) <= 1
                if not hit:
                    mismatch[(cid, c)][name] = (got, res.justification)
            total = calculate_score(checklist, results).total
            refscore = calculate_score(checklist, label_results(checklist, label)).total
            e = abs(total - refscore)
            errors.append((e, cid))
            lg = lang[row["language"]]
            lg[0] += sum(_value(by.get(c)) == label_value(label[c]) for c in CRITERIA)
            lg[1] += len(CRITERIA)
            lg[2].append(e)
        exact = sum(v[0] for v in per_crit.values())
        tot = sum(v[1] for v in per_crit.values())
        s["acc"] = pct(exact, tot)
        for c in CRITERIA:
            s[c] = pct(*per_crit[c])
        for c in SCALES:
            s[f"{c}±1"] = pct(*near[c])
        s["mae"] = round(statistics.mean(e for e, _ in errors), 2) if errors else None
        s["max_err"] = round(max(errors)[0], 2) if errors else None
        s["max_err_id"] = max(errors)[1] if errors else ""
        s["exact_total"] = pct(sum(1 for e, _ in errors if e < 0.01), len(errors))
        s["within5"] = pct(sum(1 for e, _ in errors if e <= 5), len(errors))
        for lg, (h, t, es) in sorted(lang.items()):
            s[f"lang_{lg}"] = f"{pct(h, t)} / MAE {statistics.mean(es):.2f} (n={len(es)})"
        s["conf_hi"] = f"{pct(*conf_hi)} (n={conf_hi[1]})"
        s["conf_lo"] = f"{pct(*conf_lo)} (n={conf_lo[1]})"
        s["flagged"] = pct(flagged, crit_total)
        s["evidence_ok"] = pct(ev_ok, crit_total)
        s["evidence_avg"] = round(statistics.mean(ev_items), 2) if ev_items else 0
        s["p50"], s["p95"] = q(model_secs, 0.5), q(model_secs, 0.95)
        s["wall_p50"] = q(walls, 0.5)
        s["calls"] = round(statistics.mean(calls), 2) if calls else None
        s["tin"] = round(statistics.mean(tin)) if tin else None
        s["tout"] = round(statistics.mean(tout)) if tout else None
        pi, po = PRICES[name]
        paid = (s["tin"] * pi + s["tout"] * po) / 1e6 if tin else None
        s["paid"] = f"${paid:.4f}" if paid else "—"
        s["paid10"] = f"${paid * 10:.3f}" if paid else "—"
        s["price"] = f"${pi:.2f} / ${po:.2f}"
        s["err_types"] = "; ".join(f"{k}: {v}" for k, v in err_types.most_common()) or "нет"
        stats[name] = s

    names = list(MODELS)
    rows = [
        ("Покрытие (оценено / всего чатов)", "coverage"),
        ("Совпадение по всем критериям", "acc"),
        *[(f"{c} {TITLES[c]}", c) for c in CRITERIA],
        ("c04 в пределах ±1 ступени", "c04±1"),
        ("c06 в пределах ±1 ступени", "c06±1"),
        ("MAE итога, баллов", "mae"),
        ("Худшая ошибка итога", "max_err"),
        ("Диалог с худшей ошибкой", "max_err_id"),
        ("Итог совпал точно", "exact_total"),
        ("Итог в пределах ±5 баллов", "within5"),
        ("Ложное N/A", "false_na"),
        ("Пропущенное N/A", "missed_na"),
        ("c08: пропущено нарушений", "c08_missed"),
        ("c08: ложных тревог", "c08_false"),
        *[(f"Язык {lg}: совпадение / MAE", f"lang_{lg}") for lg in ("EN", "KZ", "RU")],
        ("Точность при уверенности ≥85%", "conf_hi"),
        ("Точность при уверенности <85%", "conf_lo"),
        ("Критериев с флагом «проверить»", "flagged"),
        ("Решений с доказательством", "evidence_ok"),
        ("Цитат на критерий (среднее)", "evidence_avg"),
        ("Починок контракта (диалогов)", "repairs"),
        ("Переходов на запасную модель", "fallbacks"),
        ("Технические ошибки по типам", "err_types"),
        ("Время модели p50, с", "p50"),
        ("Время модели p95, с", "p95"),
        ("Время с очередью p50, с", "wall_p50"),
        ("Вызовов на диалог", "calls"),
        ("Токенов на вход / диалог", "tin"),
        ("Токенов на выход / диалог", "tout"),
        ("Цена на бесплатном API", None),
        ("Публичная цена вход / выход за 1M", "price"),
        ("Платный эквивалент за диалог", "paid"),
        ("Платный эквивалент за 10 диалогов", "paid10"),
    ]
    print("| Метрика | " + " | ".join(names) + " |")
    print("|---|" + "---|" * len(names))
    for title, key in rows:
        cells = ["$0" if key is None else str(stats[n].get(key, "")) for n in names]
        print(f"| {title} | " + " | ".join(cells) + " |")

    print("\n## Расхождения с эталоном на общих диалогах\n")
    print("| Диалог | Критерий | Эталон | " + " | ".join(names) + " | Кто ошибся |")
    print("|---|---|---|" + "---|" * len(names) + "---|")
    for (cid, c), by_model in sorted(mismatch.items(), key=lambda x: (x[0][1], x[0][0])):
        exp = label_value(labels[cid][c])
        cells = []
        for n in names:
            if n in by_model:
                cells.append(f"**{by_model[n][0]}**")
            else:
                cells.append(f"{exp} ✓")
        who = "все три" if len(by_model) == 3 else ", ".join(by_model)
        print(f"| {cid} | {c} | {exp} | " + " | ".join(cells) + f" | {who} |")

    print("\n## Обоснования моделей по расхождениям\n")
    for (cid, c), by_model in sorted(mismatch.items(), key=lambda x: (x[0][1], x[0][0])):
        why = labels[cid][c].get("why", "") if isinstance(labels[cid][c], dict) else ""
        print(f"- **{cid} {c}**. Эталон {label_value(labels[cid][c])}: {why}")
        for n, (got, just) in by_model.items():
            print(f"  - {n} → {got}: {(just or '').strip()[:220]}")


if __name__ == "__main__":
    main()
