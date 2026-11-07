import { X } from 'lucide-react';
import type { EvaluationRun } from '../api/types';
import { fmtDate, fmtDuration, fmtNumber } from '../lib/format';
import { FROM_CACHE } from '../lib/labels';
import { Drawer } from './ui';

/** The full run log: everything that makes the evaluation checkable. */
export function RunLogPanel({ run, onClose }: { run: EvaluationRun; onClose: () => void }) {
  const { log } = run;
  const model = log.evaluator?.model as string | undefined;
  const rows: [string, string][] = [
    ['Запуск', log.run_id],
    ['Когда', fmtDate(run.created_at)],
    ['Оценочный лист', run.checklist ? `${run.checklist.title}, версия ${run.checklist_version}` : 'Не выбран'],
    ['Модель', model ?? '—'],
    ['Схема', log.pipeline || '—'],
    ['Откуда', log.cache_hit ? `${FROM_CACHE}${log.cached_from ? `, ${log.cached_from}` : ''}` : 'Новая оценка'],
    ['Время', log.latency_ms === null ? '—' : fmtDuration(log.latency_ms)],
    ['Стоимость', log.cost_usd === null ? '—' : `$${log.cost_usd}`],
    ['Хеш диалога', log.content_hash || '—'],
    ['Хеш листа', log.checklist_hash || '—'],
    ['Хеш промпта', log.prompt_hash || '—'],
  ];
  return (
    <Drawer title="Журнал оценки" onClose={onClose}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">Журнал оценки</h2>
        <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}>
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
      <dl className="facts">
        {rows.map(([key, value]) => (
          <div key={key} className="contents">
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <h3 className="panel-label mt-6 !mb-2">Попытки</h3>
      {log.attempts.length === 0 ? (
        <p className="notice">Модель не вызывалась.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>№</th>
              <th>Модель</th>
              <th data-num>Токены</th>
              <th data-num>Время</th>
            </tr>
          </thead>
          <tbody>
            {log.attempts.map((attempt, position) => (
              <tr key={position}>
                <td>{attempt.attempt}</td>
                <td>
                  {attempt.model}
                  {!attempt.valid && <span className="block text-amber-text">Отклонено: {attempt.errors.join('; ')}</span>}
                </td>
                <td data-num>{fmtNumber(attempt.input_tokens)} / {fmtNumber(attempt.output_tokens)}</td>
                <td data-num>{attempt.latency_ms === null ? '—' : fmtDuration(attempt.latency_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Drawer>
  );
}
