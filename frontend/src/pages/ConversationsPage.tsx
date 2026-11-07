import { MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { Appeal, ConversationSummary, EvaluationRun, ImportResult } from '../api/types';
import { Button, EmptyState, ErrorState, LoadingState, Menu, Panel, Spinner, Swap, Tag } from '../components/ui';
import { host } from '../host/hostAdapter';
import {
  PERSONAL_DATA_FLAG,
  STUB_FLAG,
  channelLabel,
  errorText,
  fmtClock,
  fmtDuration,
  fmtNumber,
  fmtRelative,
  fmtScore,
  plural,
  splitImportMessages,
} from '../lib/format';
import { isActive, progressFor, useJobs, type Progress } from '../lib/jobs';
import { FROM_CACHE, GROSS, stageName } from '../lib/labels';
import { useCountUp, useElapsed } from '../lib/motion';
import { useAsync } from '../lib/useAsync';

const REFRESH_MS = 3000;
const SHORT_ERROR = 60;
const ENTER_MS = 1500;
const STAGE_PROGRESS = { parse: 0.1, model: 0.85, validate: 0.95, score: 0.95 } as const;

type Tab = 'all' | 'attention' | 'appeals';

type Finished = { ms: number | null };

/** A summary with the fields of its latest run, however they were obtained. */
type Row = ConversationSummary & {
  status: 'done' | 'failed' | null;
  error: string | null;
  reasons: string[];
  flagged: boolean;
  evaluatedAt: string | null;
  appeal: Appeal | null;
  openAppeals: number;
};

function toRow(item: ConversationSummary, run: EvaluationRun | undefined, appeals: Appeal[]): Row {
  const known = item.latest_status !== undefined;
  const reasons = (known ? item.latest_reasons : run?.review_reasons) ?? [];
  const review = known ? item.review_status : run?.review_status;
  const own = appeals.filter((appeal) => appeal.evaluation_id === item.latest_evaluation_id);
  return {
    ...item,
    status: (known ? item.latest_status : run?.status) ?? null,
    error: (known ? item.latest_error : run?.error) ?? null,
    reasons,
    // The stub flag says who answered, not that the answer is disputed.
    flagged: review === 'flagged' && reasons.some((reason) => reason !== STUB_FLAG),
    evaluatedAt: (known ? item.latest_evaluated_at : run?.created_at) ?? null,
    appeal: own[0] ?? null,
    openAppeals: item.open_appeals ?? own.length,
  };
}

const needsAttention = (row: Row) => row.gross_error || row.status === 'failed' || !row.latest_evaluation_id || row.flagged;

type Note = { text: string; tone?: 'bad' | 'warn' | 'good'; title?: string; action?: string };

function noteFor(row: Row, finished: Finished | undefined): Note | null {
  if (row.gross_error) return { text: GROSS, tone: 'bad' };
  if (row.openAppeals > 0) return { text: 'Апелляция ждёт решения' };
  if (row.status === 'failed') {
    if (row.reasons.includes(PERSONAL_DATA_FLAG)) return { text: 'Не отправлен: персональные данные', tone: 'warn', title: row.error ?? undefined };
    const reason = row.error ?? 'причина не указана';
    const short = reason.length > SHORT_ERROR ? `${reason.slice(0, SHORT_ERROR)}…` : reason;
    return { text: `Сбой: ${short}`, tone: 'warn', title: reason, action: 'Повторить' };
  }
  if (finished) {
    return { text: finished.ms === null ? FROM_CACHE : `Оценено за ${fmtDuration(finished.ms)}`, tone: 'good' };
  }
  if (row.flagged) return { text: 'Есть спорные места' };
  if (!row.latest_evaluation_id) return { text: 'Не оценён', action: 'Оценить' };
  return null;
}

function TotalCell({ row, counted }: { row: Row; counted: boolean }) {
  const shown = useCountUp(row.latest_total, { fromZero: counted });
  if (row.latest_total === null) return <span className="drow__total" data-dim>—</span>;
  return <span className="drow__total">{fmtScore(shown)}</span>;
}

function RunningCells({ progress }: { progress: Progress }) {
  const elapsed = useElapsed(progress.startedAt);
  const { stage } = progress;
  const known = stage !== null && stage !== 'queued';
  const label = stage === 'queued' ? 'В очереди' : stageName(stage ?? 'model');
  return (
    <>
      <span className="drow__total" data-dim>
        {known ? (
          <span className="meter" role="progressbar" aria-label="Ход оценки">
            <span className="meter__fill" style={{ transform: `scaleX(${STAGE_PROGRESS[stage]})` }} />
          </span>
        ) : (
          fmtClock(elapsed)
        )}
      </span>
      <span className="drow__note">
        <span className="drow-stage">
          <Spinner />
          <Swap id={label}>{label}</Swap>
        </span>
      </span>
      <span className="drow__when" data-now>только что</span>
    </>
  );
}

type RowProps = {
  row: Row;
  progress: Progress | null;
  finished: Finished | undefined;
  entering: boolean;
  onEvaluate: (ids: string[]) => void;
  tab: Tab;
};

function DialogRow({ row, progress, finished, entering, onEvaluate, tab }: RowProps) {
  const navigate = useNavigate();
  const params = tab === 'appeals' && row.appeal ? `?criterion=${encodeURIComponent(row.appeal.criterion_id)}&run=${encodeURIComponent(row.appeal.evaluation_id)}` : '';
  const href = `/conversations/${encodeURIComponent(row.id)}${params}`;
  const note = noteFor(row, finished);
  const act = (event: MouseEvent) => {
    event.stopPropagation();
    onEvaluate([row.id]);
  };
  const cells = (
    <div
      className="drow"
      data-link
      data-run={progress ? '' : undefined}
      data-settled={finished && !progress ? '' : undefined}
      onClick={() => navigate(href)}
    >
      <Link className="drow__id" to={href} onClick={(event) => event.stopPropagation()}>{row.id}</Link>
      <span className="drow__tags">
        <Tag>{channelLabel(row.channel)}</Tag>
        <Tag>{row.language}</Tag>
      </span>
      {progress ? (
        <RunningCells progress={progress} />
      ) : (
        <>
          <TotalCell row={row} counted={Boolean(finished)} />
          <span className="drow__note" data-tone={note?.tone} title={note?.title}>
            {note && <span>{note.text}</span>}
            {note?.action && <Button variant="text" onClick={act}>{note.action}</Button>}
          </span>
          <span className="drow__when" data-now={finished ? '' : undefined}>
            {finished ? 'только что' : fmtRelative(row.evaluatedAt)}
          </span>
        </>
      )}
    </div>
  );
  return entering ? <div className="row-enter"><div>{cells}</div></div> : cells;
}

function recordsIn(text: string): unknown[] {
  const parsed = JSON.parse(text) as { data?: { records?: unknown[] }; records?: unknown[] } | unknown[];
  if (Array.isArray(parsed)) return parsed;
  return parsed.data?.records ?? parsed.records ?? [parsed];
}

type Upload = { text: string; tone?: 'bad' | 'good' | 'warn' };

function ImportForm({ onDone }: { onDone: (result: ImportResult) => void }) {
  const [groupId, setGroupId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.importGroup(groupId.trim()));
    } catch (reason) {
      setError(errorText(reason, 'Импорт не удался'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input autoFocus aria-label="group_id" placeholder="group_id" className="field !w-60" value={groupId} onChange={(event) => setGroupId(event.target.value)} />
      <Button type="submit" variant="primary" disabled={busy || !groupId.trim()}>Импортировать</Button>
      {error && <span role="alert" className="notice" data-tone="bad">{error}</span>}
    </form>
  );
}

export function ConversationsPage() {
  const { jobs, revision, track } = useJobs();
  const conversations = useAsync(() => api.listConversations(), [revision]);
  const report = useAsync(() => api.getReport(), [revision]);
  const openAppeals = useAsync(() => api.listAppeals({ status: 'open' }), [revision]);
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [dragging, setDragging] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [notices, setNotices] = useState<Upload[]>([]);
  const [fresh, setFresh] = useState<Map<string, number>>(new Map());
  const [finished, setFinished] = useState<Record<string, Finished>>({});
  const [runs, setRuns] = useState<Record<string, EvaluationRun>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const reloadList = conversations.reload;
  const reloadReport = report.reload;

  const hasActive = jobs.some(isActive);
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(reloadList, REFRESH_MS);
    return () => clearInterval(timer);
  }, [hasActive, reloadList]);

  // Runs that land while this page is open get the "evaluated in" note and a counted total.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = jobs.flatMap(({ job }) => job.evaluation_ids);
    if (!seen.current) seen.current = new Set(ids);
    for (const id of ids) {
      if (seen.current.has(id)) continue;
      seen.current.add(id);
      api.getEvaluation(id).then(
        (run) =>
          setFinished((current) => ({
            ...current,
            [run.conversation_id]: { ms: run.log.cache_hit ? null : run.log.latency_ms },
          })),
        () => undefined,
      );
    }
  }, [jobs]);

  // Without the new summary fields the status of each dialogue has to be read from its run.
  const items = useMemo(() => conversations.data ?? [], [conversations.data]);
  useEffect(() => {
    for (const item of items) {
      const id = item.latest_evaluation_id;
      if (item.latest_status !== undefined || !id || runs[item.id]?.id === id) continue;
      api.getEvaluation(id).then(
        (run) => setRuns((current) => ({ ...current, [item.id]: run })),
        () => undefined,
      );
    }
  }, [items, runs]);

  const appealList = useMemo(() => openAppeals.data ?? [], [openAppeals.data]);
  const rows = useMemo(() => {
    const built = items.map((item) => toRow(item, runs[item.id], appealList));
    const weight = (row: Row) => (fresh.has(row.id) ? 2 : row.evaluatedAt ? 1 : 0);
    return built.sort(
      (a, b) => weight(b) - weight(a) || (b.evaluatedAt ?? '').localeCompare(a.evaluatedAt ?? '') || a.id.localeCompare(b.id),
    );
  }, [items, runs, appealList, fresh]);

  const needle = search.trim().toLowerCase();
  const attention = rows.filter(needsAttention);
  const withAppeals = rows.filter((row) => row.openAppeals > 0);
  const shown = (tab === 'attention' ? attention : tab === 'appeals' ? withAppeals : rows).filter(
    (row) => !needle || row.id.toLowerCase().includes(needle),
  );

  const totals = rows.flatMap((row) => (row.latest_total === null ? [] : [row.latest_total]));
  const average = totals.length ? totals.reduce((sum, value) => sum + value, 0) / totals.length : null;
  const grossCount = rows.filter((row) => row.gross_error).length;
  const failedJobs = jobs.filter(({ job, pollError }) => pollError || (job.status === 'failed' && !job.evaluation_ids.length));

  const evaluate = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return;
      try {
        track(await api.createEvaluation({ conversation_ids: ids }), ids);
      } catch (reason) {
        setNotices((current) => [...current, { text: errorText(reason, 'Не удалось запустить оценку'), tone: 'bad' }]);
      }
    },
    [track],
  );

  const uploadFiles = useCallback(
    async (files: File[]) => {
      const added: string[] = [];
      const messages: Upload[] = [];
      for (const file of files) {
        try {
          for (const record of recordsIn(await file.text())) {
            const result = await api.uploadTranscript(record);
            added.push(result.id);
            messages.push(...result.warnings.map((text) => ({ text })));
          }
        } catch (reason) {
          const text = reason instanceof SyntaxError ? 'файл не является корректным JSON' : errorText(reason, 'загрузка не удалась');
          messages.push({ text: `${file.name}: ${text}`, tone: 'bad' });
        }
      }
      setNotices(messages);
      if (!added.length) return;
      setTab('all');
      setSearch('');
      setFresh((current) => new Map([...current, ...added.map((id): [string, number] => [id, Date.now()])]));
      reloadList();
      reloadReport();
      await evaluate(added);
    },
    [evaluate, reloadList, reloadReport],
  );

  // The whole page takes a file, so the listeners sit on the window.
  useEffect(() => {
    const hasFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes('Files'));
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    };
    const onOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      uploadFiles([...(event.dataTransfer?.files ?? [])]);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [uploadFiles]);

  const download = async (format: 'json' | 'csv') => {
    try {
      if (format === 'json') {
        host.saveFile('ai-results.json', JSON.stringify(await api.exportResults(), null, 2), 'application/json');
      } else {
        // The BOM lets Excel read Cyrillic correctly.
        host.saveFile('ai-results.csv', `﻿${await api.exportCsv()}`, 'text/csv;charset=utf-8');
      }
    } catch (reason) {
      setNotices([{ text: errorText(reason, 'Экспорт не удался'), tone: 'bad' }]);
    }
  };

  const importMessages = imported ? splitImportMessages(imported.errors) : null;
  const notEvaluated = rows.filter((row) => !row.latest_evaluation_id && !progressFor(jobs, row.id, row.latest_evaluation_id)).map((row) => row.id);
  const navigate = useNavigate();

  return (
    <>
      <Panel className="head-row">
        <h1 className="title">Диалоги</h1>
        <div className="stats">
          <span className="stat"><b>{report.data?.evaluated ?? '—'}</b> из {report.data?.conversations ?? '—'} оценено</span>
          <span className="stat"><b>{fmtNumber(average, 1)}</b> средний итог</span>
          <span className="stat"><b data-tone="bad">{grossCount}</b> {plural(grossCount, 'грубое нарушение', 'грубых нарушения', 'грубых нарушений')}</span>
        </div>
        <div className="head-row__end">
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            multiple
            hidden
            aria-label="Файлы диалогов"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              uploadFiles(files);
            }}
          />
          <Button variant="primary" size="large" onClick={() => fileInput.current?.click()}>Загрузить диалог</Button>
          <Menu
            trigger={({ open, toggle }) => (
              <Button variant="icon" aria-label="Ещё" aria-expanded={open} onClick={toggle}>
                <MoreHorizontal size={16} strokeWidth={1.75} />
              </Button>
            )}
          >
            {(close) => (
              <>
                <button type="button" className="menu__item" onClick={() => { close(); setShowImport(true); }}>Импорт по group_id</button>
                <button type="button" className="menu__item" onClick={() => { close(); download('json'); }}>Экспорт JSON</button>
                <button type="button" className="menu__item" onClick={() => { close(); download('csv'); }}>Экспорт CSV</button>
                <button type="button" className="menu__item" onClick={() => { close(); navigate('/report'); }}>Подробный отчёт</button>
              </>
            )}
          </Menu>
        </div>
      </Panel>

      {(showImport || imported) && (
        <Panel className="flex flex-col gap-2 !py-4">
          {showImport && (
            <ImportForm
              onDone={(result) => {
                setImported(result);
                setShowImport(false);
                reloadList();
                reloadReport();
              }}
            />
          )}
          {imported && (
            <>
              <div className="flex items-center gap-4">
                <span className="notice" data-tone="good" role="status">Импортировано {imported.imported}, пропущено {imported.skipped}</span>
                {notEvaluated.length > 0 && <Button variant="text" onClick={() => evaluate(notEvaluated)}>Оценить неоценённые</Button>}
                <Button variant="text" className="ml-auto" onClick={() => setImported(null)}>Скрыть</Button>
              </div>
              {importMessages?.errors.map((item) => <p key={item} className="notice" data-tone="bad">{item}</p>)}
              {importMessages?.warnings.map((item) => <p key={item} className="notice">{item}</p>)}
            </>
          )}
        </Panel>
      )}

      {(notices.length > 0 || failedJobs.length > 0) && (
        <div className="flex flex-col gap-1 px-2">
          {notices.map((item, position) => <p key={position} className="notice" data-tone={item.tone}>{item.text}</p>)}
          {failedJobs.map(({ job, pollError }) => (
            <p key={job.id} className="notice" data-tone="warn">
              {pollError ? `Связь с оценкой потеряна: ${pollError}` : `Сбой: ${job.errors.join('; ') || 'оценка прервана'}`}
            </p>
          ))}
        </div>
      )}

      <div className="tabs-row">
        <div role="tablist" className="flex gap-5">
          {(
            [
              ['all', 'Все', rows.length],
              ['attention', 'Требуют внимания', attention.length],
              ['appeals', 'Апелляции', withAppeals.length],
            ] as const
          ).map(([id, label, count]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className="tab" onClick={() => setTab(id)}>
              {label} {count}
            </button>
          ))}
        </div>
        <input
          aria-label="Поиск по номеру диалога"
          placeholder="Поиск по номеру"
          className="field tabs-row__search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <Panel className="dialogs" data-over={dragging || undefined}>
        <div className="drow drow--head">
          <span>Диалог</span>
          <span>Канал</span>
          <span className="flex justify-end">Итог</span>
          <span>Отметка</span>
          <span className="justify-self-end">Когда</span>
        </div>
        <div className="dialogs__scroll">
          {conversations.error ? (
            <ErrorState message={conversations.error} onRetry={reloadList} />
          ) : !conversations.data ? (
            <LoadingState label="Загружаем диалоги…" />
          ) : !shown.length ? (
            <EmptyState title={rows.length ? 'Здесь ничего нет' : 'Диалогов пока нет'}>
              {!rows.length && 'Перетащите файл .json сюда или импортируйте группу через меню.'}
            </EmptyState>
          ) : (
            shown.map((row) => (
              <DialogRow
                key={row.id}
                row={row}
                tab={tab}
                progress={progressFor(jobs, row.id, row.latest_evaluation_id)}
                finished={finished[row.id]}
                entering={Date.now() - (fresh.get(row.id) ?? 0) < ENTER_MS}
                onEvaluate={evaluate}
              />
            ))
          )}
        </div>
      </Panel>
    </>
  );
}
