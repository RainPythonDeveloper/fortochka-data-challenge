import { useState } from 'react';
import { api } from '../api';
import type { CompareCriterion, CompareValue, EvaluationSummary } from '../api/types';
import { fmtNumber, plainAnswer, runLabel } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Badge, Button, ErrorState, Field, LoadingState, Modal, inputClass } from './ui';

const signed = (value: number | null) =>
  value === null ? '—' : `${value > 0 ? '+' : ''}${fmtNumber(value)}`;

function ValueCell({ value }: { value: CompareValue | null }) {
  if (!value) return <td className="px-2 py-1 text-stone-400">Нет в этом запуске</td>;
  return (
    <td className="px-2 py-1">
      {plainAnswer(value.status, value.answer)}
      <span className="ml-2 text-xs text-stone-500 tabular-nums">
        {fmtNumber(value.points)} б., вес {fmtNumber(value.weight)}
      </span>
    </td>
  );
}

const isChanged = (item: CompareCriterion) => item.answer_changed || item.points_changed;

/** Two runs of one dialogue. The server compares the original automatic results. */
export function CompareDialog({ runs, onClose }: { runs: EvaluationSummary[]; onClose: () => void }) {
  // Runs arrive newest first: the default compares the previous run with the latest.
  const [a, setA] = useState(runs[1].id);
  const [b, setB] = useState(runs[0].id);
  const compare = useAsync(() => (a === b ? Promise.resolve(null) : api.compareEvaluations(a, b)), [a, b]);
  const data = compare.data;

  const picker = (label: string, value: string, onChange: (id: string) => void) => (
    <Field label={label}>
      <select aria-label={label} className={inputClass} value={value} onChange={(event) => onChange(event.target.value)}>
        {runs.map((run) => (
          <option key={run.id} value={run.id}>{runLabel(run)}</option>
        ))}
      </select>
    </Field>
  );

  return (
    <Modal title="Сравнение запусков" wide onClose={onClose}>
      <div className="grid grid-cols-2 gap-2">
        {picker('Запуск A', a, setA)}
        {picker('Запуск B', b, setB)}
      </div>

      {a === b ? (
        <p className="mt-3 text-stone-500">Выберите два разных запуска.</p>
      ) : compare.error ? (
        <ErrorState message={compare.error} onRetry={compare.reload} />
      ) : !data || compare.loading ? (
        <LoadingState label="Сравниваем…" />
      ) : (
        <div data-testid="compare-result" className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <span>
              Итог: {fmtNumber(data.a.total)} → <b className="tabular-nums">{fmtNumber(data.b.total)}</b>
              <span className="ml-1 text-stone-500 tabular-nums">({signed(data.total_delta)})</span>
            </span>
            <span>
              После решений: {fmtNumber(data.a.final_total)} → <b className="tabular-nums">{fmtNumber(data.b.final_total)}</b>
              <span className="ml-1 text-stone-500 tabular-nums">({signed(data.final_total_delta)})</span>
            </span>
            <span>Изменилось критериев: <b>{data.changed_criteria.length}</b></span>
          </div>
          <div className="flex flex-wrap gap-1">
            <Badge tone={data.same_rubric ? 'neutral' : 'warn'}>{data.same_rubric ? 'Смысл рубрики тот же' : 'Смысл рубрики изменился'}</Badge>
            <Badge tone={data.same_content ? 'neutral' : 'warn'}>{data.same_content ? 'Диалог тот же' : 'Диалог изменился'}</Badge>
            {data.b.cache_hit && <Badge>B из кэша, модель не вызывалась</Badge>}
            {data.a.final_gross_error !== data.b.final_gross_error && <Badge tone="bad">Флаг грубой ошибки различается</Badge>}
          </div>
          <table className="w-full border-t border-line">
            <thead className="text-left text-xs text-stone-500">
              <tr>
                <th className="px-2 py-1 font-medium">Критерий</th>
                <th className="px-2 py-1 font-medium">A, v{data.a.checklist_version}</th>
                <th className="px-2 py-1 font-medium">B, v{data.b.checklist_version}</th>
                <th className="px-2 py-1 text-right font-medium">Разница</th>
              </tr>
            </thead>
            <tbody>
              {data.criteria.map((item) => (
                <tr
                  key={item.criterion_id}
                  data-compare-row={item.criterion_id}
                  data-changed={isChanged(item)}
                  className={`border-t border-stone-100 ${isChanged(item) ? 'bg-amber-50' : ''}`}
                >
                  <td className="px-2 py-1 font-medium">{item.title}</td>
                  <ValueCell value={item.a} />
                  <ValueCell value={item.b} />
                  <td className="px-2 py-1 text-right tabular-nums">{signed(item.points_delta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-stone-500">Таблица сравнивает исходные автоматические результаты, решения по апелляциям в ней не учтены.</p>
        </div>
      )}

      <div className="mt-3 flex justify-end">
        <Button onClick={onClose}>Закрыть</Button>
      </div>
    </Modal>
  );
}
