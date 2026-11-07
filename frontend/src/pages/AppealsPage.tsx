import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { Appeal, ResultStatus } from '../api/types';
import { EmptyState, ErrorState, LoadingState, Panel } from '../components/ui';
import { fmtDate, plainAnswer } from '../lib/format';
import { useJobs } from '../lib/jobs';
import { useAsync } from '../lib/useAsync';

type Filter = 'open' | 'decided' | 'all';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'open', label: 'Ждут решения' },
  { id: 'decided', label: 'Решённые' },
  { id: 'all', label: 'Все' },
];

function modelAnswer(appeal: Appeal): string {
  if (!appeal.model_status) return '—';
  return plainAnswer(appeal.model_status as ResultStatus, appeal.model_answer ?? null);
}

function decisionText(appeal: Appeal): string {
  const decision = appeal.decision;
  if (!decision) return '—';
  if (decision.decision === 'confirm') return 'Оценка модели подтверждена';
  const status = (decision.new_status ?? 'assessed') as ResultStatus;
  return `Изменено на «${plainAnswer(status, decision.new_answer ?? null)}»`;
}

function link(appeal: Appeal): string {
  const params = new URLSearchParams({ criterion: appeal.criterion_id, run: appeal.evaluation_id });
  return `/conversations/${encodeURIComponent(appeal.conversation_id ?? '')}?${params.toString()}`;
}

/** The reviewer's queue: every appeal with its context, open ones first. */
export function AppealsPage() {
  const { revision } = useJobs();
  const [filter, setFilter] = useState<Filter>('open');
  const appeals = useAsync(() => api.listAppeals(), [revision]);
  const all = appeals.data ?? [];
  const shown = all.filter((item) => filter === 'all' || item.status === filter);
  const open = all.filter((item) => item.status === 'open').length;

  return (
    <div className="report">
      <Panel className="head-row">
        <h1 className="title">Апелляции</h1>
        <div className="stats">
          <span className="stat"><b>{open}</b> ждут решения</span>
          <span className="stat"><b>{all.length - open}</b> решено</span>
        </div>
        <div className="head-row__end">
          <span className="notice">Решение принимает человек: откройте диалог, изучите цитаты и правило, подтвердите или измените оценку.</span>
        </div>
      </Panel>

      <Panel>
        <div role="tablist" className="tabs mb-3">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              className="tab"
              aria-selected={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {appeals.error ? (
          <ErrorState message={appeals.error} onRetry={appeals.reload} />
        ) : !appeals.data ? (
          <LoadingState label="Загружаем апелляции…" />
        ) : !shown.length ? (
          <EmptyState title={filter === 'open' ? 'Нет апелляций, ждущих решения' : 'Апелляций нет'}>
            Апелляцию подают в разборе диалога: кнопка «Проверка человеком» под итоговым баллом.
          </EmptyState>
        ) : (
          <div className="appeals-scroll">
            <table className="table appeals-table">
              <thead>
                <tr>
                  <th>Статус</th>
                  <th>Диалог</th>
                  <th>Критерий</th>
                  <th>Ответ модели</th>
                  <th>Комментарий апелляции</th>
                  <th>Решение</th>
                  <th>Причина · проверяющий</th>
                  <th>Подана</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((appeal) => (
                  <tr key={appeal.id}>
                    <td>
                      <span className="appeal-state" data-state={appeal.status}>
                        {appeal.status === 'open' ? 'ждёт решения' : 'решено'}
                      </span>
                    </td>
                    <td>
                      {appeal.conversation_id ? (
                        <Link to={link(appeal)} className="appeal-link">{appeal.conversation_id}</Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{appeal.criterion_title ?? appeal.criterion_id}</td>
                    <td>{modelAnswer(appeal)}</td>
                    <td className="appeals-table__text">«{appeal.comment}»</td>
                    <td>
                      {appeal.status === 'open' && appeal.conversation_id ? (
                        <Link to={link(appeal)} className="btn" data-variant="primary">Принять решение</Link>
                      ) : (
                        decisionText(appeal)
                      )}
                    </td>
                    <td className="appeals-table__text">
                      {appeal.decision ? `${appeal.decision.reason} · ${appeal.decision.reviewer}` : '—'}
                    </td>
                    <td>{fmtDate(appeal.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
