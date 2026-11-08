import type { ChecklistVersion, ExportResult } from '../api/types';
import { fmtNumber, maxLevel, plural } from '../lib/format';
import { VERDICTS, verdictOf, type VerdictId } from '../lib/scoreBands';
import { Panel } from './ui';

function shareOfFull(answer: unknown, top: number | null): number | null {
  if (answer === 'yes') return 1;
  if (answer === 'no') return 0;
  return typeof answer === 'number' && top ? answer / top : null;
}

type CriterionRow = { id: string; title: string; weight: number; mean: number; rated: number };

/**
 * Each answer is read against the criterion of its own checklist. A copy of a sheet
 * can reuse an id with another meaning or scale, so rows are keyed by title and
 * weight: the chat and voice versions of one criterion merge, a changed one stays apart.
 */
function criterionRows(results: ExportResult | null, sheets: ChecklistVersion[]): CriterionRow[] {
  const byId = new Map(sheets.map((sheet) => [sheet.checklist_id, sheet]));
  const rows = new Map<string, { id: string; title: string; weight: number; shares: number[] }>();
  for (const item of results?.results ?? []) {
    if (item.status !== 'done' || !item.checklist_id) continue;
    const sheet = byId.get(item.checklist_id);
    if (!sheet) continue;
    for (const criterion of sheet.criteria) {
      if (!criterion.scored || criterion.flag) continue;
      const entry = item.criteria.find((candidate) => candidate.criterion_id === criterion.id);
      const top = criterion.type === 'scale' ? maxLevel(criterion) : null;
      const share = entry?.status === 'assessed' ? shareOfFull(entry.answer, top) : null;
      if (share === null || share > 1) continue;
      const key = `${criterion.title}|${criterion.weight}`;
      const row = rows.get(key) ?? { id: key, title: criterion.title, weight: criterion.weight, shares: [] };
      row.shares.push(share);
      rows.set(key, row);
    }
  }
  return [...rows.values()]
    .map(({ shares, ...row }) => ({ ...row, mean: shares.reduce((sum, value) => sum + value, 0) / shares.length, rated: shares.length }))
    .sort((a, b) => a.mean - b.mean);
}

type Props = {
  average: number | null;
  counts: Record<VerdictId, number>;
  active: VerdictId | null;
  onVerdict: (id: VerdictId | null) => void;
  results: ExportResult | null;
  sheets: ChecklistVersion[];
};

/** The numbers behind the list: how good the dialogues are and on which criteria. */
export function StatsPanel({ average, counts, active, onVerdict, results, sheets }: Props) {
  const rows = criterionRows(results, sheets);
  const rated = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const verdict = average === null ? null : verdictOf(average, false);
  return (
    <Panel className="stats-panel">
      <div className="stats-panel__top">
        <div>
          <p className="ctl__label">Средний итог</p>
          <p className="stats-panel__value">{fmtNumber(average, 1)}<small> из 100</small></p>
        </div>
        {verdict && <span className="verdict" data-verdict={verdict.id} data-size="large">{verdict.name}</span>}
      </div>

      <div className="split split--big" aria-hidden>
        {VERDICTS.map((item) => <span key={item.id} data-part={item.id} style={{ flexGrow: counts[item.id] }} />)}
      </div>
      <div className="legend">
        {VERDICTS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="legend__item"
            aria-pressed={active === item.id}
            title={`${item.name}: ${item.hint}`}
            onClick={() => onVerdict(active === item.id ? null : item.id)}
          >
            <span className="verdict" data-verdict={item.id}>{item.name}</span>
            <b>{counts[item.id]}</b>
          </button>
        ))}
      </div>

      <h2 className="stats-panel__title">Средний балл по критериям</h2>
      {rows.length === 0 ? (
        <p className="notice">Появится после первых оценок.</p>
      ) : (
        <>
          <p className="ctl__hint mb-2">Сверху самые слабые.</p>
          <div className="crit-stats">
            {rows.map((row) => {
              const tone = verdictOf(row.mean * 100, false)?.id;
              return (
                <div key={row.id} className="crit-stat" title={`${row.title}: по ${row.rated} ${plural(row.rated, 'диалогу', 'диалогам', 'диалогам')}`}>
                  <span>{row.title}</span>
                  <b>{fmtNumber(row.mean * row.weight, 1)} из {fmtNumber(row.weight)}</b>
                  <div className="crit-stat__bar" aria-hidden>
                    <span data-part={tone} style={{ transform: `scaleX(${row.mean})` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {rated > 0 && <p className="why__small mt-3">Оценено диалогов: {rated}. Решения по апелляциям в баллах по критериям не учтены.</p>}
    </Panel>
  );
}
