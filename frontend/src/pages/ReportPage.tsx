import { useState, type ReactNode } from 'react';
import { api } from '../api';
import type { ReportBucket } from '../api/types';
import { Banner, Button, EmptyState, ErrorState, LoadingState, inputClass } from '../components/ui';
import { channelLabel, fmtDate, fmtNumber } from '../lib/format';
import { useJobs } from '../lib/jobs';
import { useAsync } from '../lib/useAsync';

function Stat({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="rounded border border-line bg-white px-3 py-2">
      <p className="text-xs text-stone-500">{label}</p>
      <p className="text-xl font-semibold tabular-nums leading-tight">{value}</p>
      {note && <p className="text-xs text-stone-500">{note}</p>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded border border-line bg-white p-3">
      <h2 className="mb-1.5 font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function BucketTable({ head, rows, label }: { head: string; rows: ReportBucket[]; label: (key: string) => string }) {
  if (!rows.length) return <p className="text-stone-500">Нет данных</p>;
  return (
    <table className="w-full">
      <thead className="text-left text-xs text-stone-500">
        <tr>
          <th className="py-0.5 font-medium">{head}</th>
          <th className="py-0.5 text-right font-medium">Диалогов, n</th>
          <th className="py-0.5 text-right font-medium">Оценено</th>
          <th className="py-0.5 text-right font-medium">Сбоев</th>
          <th className="py-0.5 text-right font-medium">Без оценки</th>
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {rows.map((row) => (
          <tr key={row.key} data-bucket={row.key} className="border-t border-stone-100">
            <td className="py-0.5">{label(row.key)}</td>
            <td className="py-0.5 text-right font-semibold">{row.conversations}</td>
            <td className="py-0.5 text-right">{row.evaluated}</td>
            <td className="py-0.5 text-right">{row.failed}</td>
            <td className="py-0.5 text-right">{row.not_evaluated}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ReportPage() {
  const { revision } = useJobs();
  const [input, setInput] = useState('');
  const [groupId, setGroupId] = useState('');
  const report = useAsync(() => api.getReport(groupId || undefined), [groupId, revision]);
  const data = report.data;

  return (
    <div className="mx-auto max-w-[1100px] space-y-3 p-4">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setGroupId(input.trim());
        }}
      >
        <h1 className="mr-2 text-base font-semibold">Отчёт</h1>
        <input
          aria-label="group_id отчёта"
          placeholder="Все группы"
          className={`${inputClass} !w-40`}
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <Button type="submit">Показать</Button>
        {data && <span className="ml-auto text-stone-500">Сформирован {fmtDate(data.generated_at)}</span>}
      </form>

      {report.error ? (
        <ErrorState message={report.error} onRetry={report.reload} />
      ) : !data ? (
        <LoadingState label="Собираем отчёт…" />
      ) : !data.conversations ? (
        <EmptyState title={groupId ? `В группе ${groupId} диалогов нет` : 'Диалогов пока нет'} />
      ) : (
        <>
          {data.mock_used && (
            <Banner tone="warn" title="В выборке есть результаты провайдера-заглушки">
              Эти оценки получены без модели и не показывают качество.
            </Banner>
          )}
          <div className="grid grid-cols-5 gap-2">
            <Stat label="Диалогов" value={data.conversations} />
            <Stat label="Оценено" value={data.evaluated} />
            <Stat label="Сбоев" value={data.failed} />
            <Stat label="Без оценки" value={data.not_evaluated} />
            <Stat label="С частичным итогом" value={data.partial} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Panel title="По языкам"><BucketTable head="Язык" rows={data.by_language} label={(key) => key} /></Panel>
            <Panel title="По каналам"><BucketTable head="Канал" rows={data.by_channel} label={channelLabel} /></Panel>
            <Panel title="Чек-листы последних запусков">
              {data.checklists.length ? (
                <ul>
                  {data.checklists.map((item) => (
                    <li key={`${item.checklist_id}:${item.version}`} className="flex justify-between tabular-nums">
                      <span>{item.checklist_id} v{item.version}</span>
                      <span>n = <b>{item.conversations}</b></span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-stone-500">Запусков нет</p>
              )}
            </Panel>
            <Panel title="Оценщики последних запусков">
              {data.evaluators.length ? (
                <ul>
                  {data.evaluators.map((item) => (
                    <li key={`${item.provider}:${item.model}:${item.pipeline}`} className="flex justify-between tabular-nums">
                      <span>{item.provider} / {item.model}, {item.pipeline}</span>
                      <span>n = <b>{item.conversations}</b></span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-stone-500">Запусков нет</p>
              )}
            </Panel>
          </div>
          <Panel title="Все запуски выборки">
            <dl className="grid grid-cols-3 gap-x-6 gap-y-0.5 tabular-nums">
              {(
                [
                  ['Запусков', data.runs],
                  ['Сбойных запусков', data.failed_runs],
                  ['Из кэша', data.cache_hits],
                  ['Обращений к модели', data.model_attempts],
                  ['Средняя задержка', data.avg_latency_ms === null ? '—' : `${fmtNumber(data.avg_latency_ms)} мс`],
                  ['Стоимость', data.total_cost_usd === null ? '—' : `$${data.total_cost_usd}`],
                  ['Запусков без данных о цене', data.runs_without_cost],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex justify-between border-b border-stone-100">
                  <dt className="text-stone-600">{label}</dt>
                  <dd className="font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </>
      )}
    </div>
  );
}
