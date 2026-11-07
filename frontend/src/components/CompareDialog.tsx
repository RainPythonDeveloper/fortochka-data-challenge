import { X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import type { CompareCriterion, CompareValue, EvaluationSummary } from '../api/types';
import { fmtNumber, fmtScore, plainAnswer, runLabel } from '../lib/format';
import { FROM_CACHE } from '../lib/labels';
import { useAsync } from '../lib/useAsync';
import { Button, ErrorState, LoadingState, Modal, Tag } from './ui';

const signed = (value: number | null) => (value === null ? '—' : `${value > 0 ? '+' : ''}${fmtScore(value)}`);

function ValueCell({ value }: { value: CompareValue | null }) {
  if (!value) return <td className="text-text">Нет в этой оценке</td>;
  return (
    <td>
      {plainAnswer(value.status, value.answer)}
      <span className="ml-2 text-text">{fmtNumber(value.points)} б., вес {fmtNumber(value.weight)}</span>
    </td>
  );
}

const isChanged = (item: CompareCriterion) => item.answer_changed || item.points_changed;

function Comparison({ runs }: { runs: EvaluationSummary[] }) {
  // Runs arrive newest first: the default compares the previous run with the latest.
  const [a, setA] = useState(runs[1].id);
  const [b, setB] = useState(runs[0].id);
  const compare = useAsync(() => (a === b ? Promise.resolve(null) : api.compareEvaluations(a, b)), [a, b]);
  const data = compare.data;

  const picker = (label: string, value: string, onChange: (id: string) => void) => (
    <label className="tfield !mb-0">
      <span className="tfield__label">{label}</span>
      <select className="field" value={value} onChange={(event) => onChange(event.target.value)}>
        {runs.map((run) => <option key={run.id} value={run.id}>{runLabel(run)}</option>)}
      </select>
    </label>
  );

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        {picker('Оценка A', a, setA)}
        {picker('Оценка B', b, setB)}
      </div>
      {a === b ? (
        <p className="notice mt-3">Выберите две разные оценки.</p>
      ) : compare.error ? (
        <ErrorState message={compare.error} onRetry={compare.reload} />
      ) : !data || compare.loading ? (
        <LoadingState label="Сравниваем…" />
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <div className="stats">
            <span className="stat"><b>{fmtScore(data.a.total)} → {fmtScore(data.b.total)}</b> итог ({signed(data.total_delta)})</span>
            <span className="stat"><b>{fmtScore(data.a.final_total)} → {fmtScore(data.b.final_total)}</b> после решений ({signed(data.final_total_delta)})</span>
            <span className="stat"><b>{data.changed_criteria.length}</b> изменилось</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Tag tone={data.same_rubric ? undefined : 'amber'}>{data.same_rubric ? 'Смысл листа тот же' : 'Смысл листа изменился'}</Tag>
            <Tag tone={data.same_content ? undefined : 'amber'}>{data.same_content ? 'Диалог тот же' : 'Диалог изменился'}</Tag>
            {data.b.cache_hit && <Tag>B: {FROM_CACHE.toLowerCase()}</Tag>}
            {data.a.final_gross_error !== data.b.final_gross_error && <Tag tone="amber">Отметка о грубом нарушении различается</Tag>}
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Критерий</th>
                <th>A, версия {data.a.checklist_version}</th>
                <th>B, версия {data.b.checklist_version}</th>
                <th data-num>Разница</th>
              </tr>
            </thead>
            <tbody>
              {data.criteria.map((item) => (
                <tr key={item.criterion_id} className={isChanged(item) ? 'bg-amber-soft' : undefined}>
                  <td className="font-medium">{item.title}</td>
                  <ValueCell value={item.a} />
                  <ValueCell value={item.b} />
                  <td data-num>{signed(item.points_delta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="notice">Таблица сравнивает исходные автоматические результаты, решения по апелляциям в ней не учтены.</p>
        </div>
      )}
    </>
  );
}

type Props = { runs: EvaluationSummary[]; shownId: string | null; onOpen: (id: string) => void; onClose: () => void };

/** The runs of one dialogue. The server compares the original automatic results. */
export function CompareDialog({ runs, shownId, onOpen, onClose }: Props) {
  const done = runs.filter((run) => run.status === 'done');
  return (
    <Modal title="История оценок" onClose={onClose}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">История оценок</h2>
        <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}>
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
      <table className="table mb-5">
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>{runLabel(run)}{run.status === 'failed' && run.error ? `: ${run.error}` : ''}</td>
              <td data-num>
                {run.id === shownId ? <span className="text-text">показана</span> : (
                  <Button variant="text" onClick={() => onOpen(run.id)}>Открыть</Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {done.length >= 2 ? <Comparison runs={done} /> : <p className="notice">Для сравнения нужны две завершённые оценки.</p>}
    </Modal>
  );
}
