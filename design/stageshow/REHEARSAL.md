# Sapa screens: rehearsal notes

Animated product demos of Sapa's three screens, built with the stageshow skill (`benjitaylor/skills`: kit and filming tools). One look everywhere: the deep green product bar (the logo's own green), then white panels with a soft radius on a light gray ground. Freedom green marks good answers and links; red marks only "Нет" and gross violations; the primary action carries Freedom's brand gradient. The bar is shared code (`sapa-review/shell.tsx`), the look is shared CSS (`sapa-review/sapa.css`).

| Screen | Folder | Plays |
|---|---|---|
| Диалоги | `sapa-dialogs` | once |
| Разбор диалога | `sapa-review` | loops |
| Оценочный лист | `sapa-sheet` | once |

## Диалоги, about 9 seconds, once

1. A transcript file is carried in by the pointer from past the left edge; the list lights up under it.
2. On the drop a new row opens at the top, tinted, and runs the evaluation in place: «Разбор диалога», «Оценка моделью» counting the criteria with a progress bar, «Проверка цитат».
3. The total lands (92,31), «Оценено за 1 мин 5 с», and the tint fades: an ordinary row.

The head carries three figures: evaluated of all, the average total, gross violations. Three older dialogues are real rows; the rest are placeholder lines.

## Оценочный лист, about 6 seconds, once

1. «Завершение» is open beside the list of criteria and weights.
2. The reviewer turns off the note that reads a bare goodbye as «Нет»: it dims, the criterion is marked «изменён», and the head says the meaning changed so dialogues will be evaluated again, beside «Сохранить версию 2».
3. The save lands: the version tag rolls to 2, «Прошлые оценки остались на версии 1».

## Разбор диалога, about 16 seconds, loops

1. The head shows the stages on one rail, each with its time: «Разбор диалога», «Оценка моделью» (counts the criteria as they land), «Проверка цитат», «Расчёт итога».
2. While the model works, the criteria resolve top to bottom; each lights the turn it rests on.
3. The total rolls in and its marker settles in the range bar: низкий below 60, средний 60 to 80, высокий 80 and above.
4. The pointer opens «Завершение»: the explanation opens and a line draws from the criterion to turn #12; #11 to #13 are marked as the checked range.
5. The reviewer presses «Изменить на «Да»»: the badge turns, the total rolls to 85,38 a beat later, the marker crosses into the high band, «исходная 77,69» stays beside it.
6. «Оценить заново» is the visible cause of the reset.

Poster (reduced motion, thumbnails): everything done, «Завершение» open with its explanation, the line to its evidence and the two decisions.

## Wording

Russian product terms: «Оценочный лист» for the checklist, «Переписка» for the transcript, «Не применимо» for N/A, «Не выявлены» for gross violations. No criterion codes on screen. The dialogue's channel and language are tags beside the title. Criterion titles are shortened here for the illustration; the app shows the official titles from the checklist data (see `../SAPA_UI_SPEC.md`, section 9).

## Gold copied

- `loading`: skeleton at the content's own geometry, answers resolving in place.
- `table-edit`: the total rolls a beat after the edit that feeds it.
- `linear`: wide hero, window inset top and sides, off the bottom; color only on the product's own marks.
- `panel-annotation`: one connector from a setting to what it changed, here from a criterion to its evidence.

## Checks

- `film.mjs --gate` on all three screens: `rehearsal passed`, and `--states` contact sheets read beat by beat.
- Typecheck clean.
- `upload` was the gold for the drag in «Диалоги»; its desktop column broke the one-gutter rule here, so the file enters from past the stage edge instead.

## Not checked or known

- No phone-width design: the demo is for a desktop pitch and the app; on a narrow screen the stage scales down whole.
- Inter loads from Google Fonts in the playground, so the first 0.6 s show a font swap; the app should self-host Inter.
- Film reports "lopsided" on the «Завершение» row: it measures the text inside the switching badge, not the badge's edge; measured in the browser the badge sits at the same inset as every other row.
- The stage times are this dialogue's illustrative values; the app should show the real times from the run log.
- The score bands (60 and 80) are our choice, not part of the official checklist.
- No independent fresh-eye review was run.

## Run it

Copy the three folders into the stageshow skill's `examples/`, run its playground (`npm install`, `npm run dev`) and open `?capture=sapa-dialogs`, `?capture=sapa-review` or `?capture=sapa-sheet`. The Freedom logo files are the brand's own artwork, taken from fbroker.kz.
