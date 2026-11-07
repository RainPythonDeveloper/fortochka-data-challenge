import { Link } from 'react-router-dom';
import { api } from '../api';
import type { ReportBucket } from '../api/types';
import { EmptyState, ErrorState, LoadingState, Panel } from '../components/ui';
import { channelLabel, fmtDate, fmtDuration, languageLabel, plural } from '../lib/format';
import { useJobs } from '../lib/jobs';
import { FROM_CACHE } from '../lib/labels';
import { useAsync } from '../lib/useAsync';

function BucketTable({ head, rows, label }: { head: string; rows: ReportBucket[]; label: (key: string) => string }) {
  if (!rows.length) return <p className="notice">Нет данных</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{head}</th>
          <th data-num>Диалогов</th>
          <th data-num>Оценено</th>
          <th data-num>Сбоев</th>
          <th data-num>Не оценено</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td>{label(row.key)}</td>
            <td data-num className="font-semibold">{row.conversations}</td>
            <td data-num>{row.evaluated}</td>
            <td data-num>{row.failed}</td>
            <td data-num>{row.not_evaluated}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ReportPage() {
  const { revision } = useJobs();
  const report = useAsync(() => api.getReport(), [revision]);
  const data = report.data;

  return (
    <div className="report">
      <Panel className="head-row">
        <h1 className="title">Подробный отчёт</h1>
        {data && (
          <div className="stats">
            <span className="stat"><b>{data.evaluated}</b> из {data.conversations} оценено</span>
            <span className="stat"><b>{data.failed}</b> {plural(data.failed, 'сбой', 'сбоя', 'сбоев')}</span>
            <span className="stat"><b>{data.partial}</b> с частичным итогом</span>
          </div>
        )}
        <div className="head-row__end">
          {data && <span className="notice">Сформирован {fmtDate(data.generated_at)}</span>}
          <Link to="/conversations" className="btn" data-variant="text">К диалогам</Link>
        </div>
      </Panel>

      {report.error ? (
        <Panel><ErrorState message={report.error} onRetry={report.reload} /></Panel>
      ) : !data ? (
        <Panel><LoadingState label="Собираем отчёт…" /></Panel>
      ) : !data.conversations ? (
        <Panel><EmptyState title="Диалогов пока нет" /></Panel>
      ) : (
        <>
          {data.mock_used && <p className="notice px-2" data-tone="warn">В выборке есть оценки на синтетических данных, они не показывают качество.</p>}
          <div className="report__grid">
            <Panel>
              <div className="panel-label">По языкам</div>
              <BucketTable head="Язык" rows={data.by_language} label={languageLabel} />
            </Panel>
            <Panel>
              <div className="panel-label">По каналам</div>
              <BucketTable head="Канал" rows={data.by_channel} label={channelLabel} />
            </Panel>
            <Panel>
              <div className="panel-label">Оценочные листы последних оценок</div>
              <table className="table">
                <tbody>
                  {data.checklists.map((item) => (
                    <tr key={`${item.checklist_id}:${item.version}`}>
                      <td>{item.checklist_id}, версия {item.version}</td>
                      <td data-num>{item.conversations}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            <Panel>
              <div className="panel-label">Модели последних оценок</div>
              <table className="table">
                <tbody>
                  {data.evaluators.map((item) => (
                    <tr key={`${item.provider}:${item.model}:${item.pipeline}`}>
                      <td>{item.model}, {item.provider}</td>
                      <td data-num>{item.conversations}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </div>
          <Panel>
            <div className="panel-label">Все оценки</div>
            <table className="table">
              <tbody>
                {(
                  [
                    ['Оценок', data.runs],
                    ['Сбойных оценок', data.failed_runs],
                    [FROM_CACHE, data.cache_hits],
                    ['Обращений к модели', data.model_attempts],
                    ['Среднее время', data.avg_latency_ms === null ? '—' : fmtDuration(data.avg_latency_ms)],
                    ['Стоимость', data.total_cost_usd === null ? '—' : `$${data.total_cost_usd}`],
                    ['Оценок без данных о цене', data.runs_without_cost],
                  ] as const
                ).map(([label, value]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td data-num className="font-medium">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </div>
  );
}
