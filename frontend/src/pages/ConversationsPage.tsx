import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Gavel,
  MoreHorizontal,
  Play,
  Plus,
  RotateCw,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { Appeal, ChecklistVersion, ConversationSummary, EvaluationRun, ImportResult } from '../api/types';
import { ChannelMark } from '../components/ChannelMark';
import { SetTag } from '../components/SetTag';
import { StatsPanel } from '../components/DashboardRail';
import { Button, EmptyState, ErrorState, LoadingState, Menu, Panel, Spinner, Swap } from '../components/ui';
import { host } from '../host/hostAdapter';
import {
  PERSONAL_DATA_FLAG,
  STUB_FLAG,
  errorText,
  fmtClock,
  fmtDuration,
  fmtRelative,
  fmtScore,
  splitImportMessages,
} from '../lib/format';
import { isActive, progressFor, useJobs, type Progress } from '../lib/jobs';
import { FROM_CACHE, GROSS, stageName } from '../lib/labels';
import { useCountUp, useElapsed } from '../lib/motion';
import { VERDICTS, verdictOf, type VerdictId } from '../lib/scoreBands';
import { useAsync } from '../lib/useAsync';

const REFRESH_MS = 3000;
const SHORT_ERROR = 60;
const ENTER_MS = 1500;
const STAGE_PROGRESS = { parse: 0.1, model: 0.85, validate: 0.95, score: 0.95 } as const;

type Tab = 'all' | 'attention' | 'appeals' | 'gross' | 'failed' | 'waiting' | 'disputed';
type Sort = { key: 'when' | 'total'; descending: boolean };

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
  /** The checklist total; a gross violation is shown separately. */
  total: number | null;
  verdict: ReturnType<typeof verdictOf>;
};

function toRow(item: ConversationSummary, run: EvaluationRun | undefined, own: Appeal[]): Row {
  const known = item.latest_status !== undefined;
  const reasons = (known ? item.latest_reasons : run?.review_reasons) ?? [];
  const review = known ? item.review_status : run?.review_status;
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
    total: item.latest_total,
    verdict: verdictOf(item.latest_total, item.gross_error),
  };
}

const needsAttention = (row: Row) => row.gross_error || row.status === 'failed' || !row.latest_evaluation_id || row.flagged;
const isBlocked = (row: Row) => row.reasons.includes(PERSONAL_DATA_FLAG);

const TAB_LABELS: Record<Tab, string> = {
  all: 'Все',
  attention: 'Требуют внимания',
  waiting: 'Не оценены',
  gross: 'Грубые нарушения',
  appeals: 'Апелляции',
  failed: 'Сбои оценки',
  disputed: 'Спорные места',
};
const MAIN_TABS: Tab[] = ['all', 'attention', 'waiting'];

const TAB_FILTERS: Record<Tab, (row: Row) => boolean> = {
  all: () => true,
  attention: needsAttention,
  appeals: (row) => row.openAppeals > 0,
  gross: (row) => row.gross_error,
  failed: (row) => row.status === 'failed',
  waiting: (row) => !row.latest_evaluation_id,
  disputed: (row) => row.flagged,
};

type Note = { text: string; tone?: 'bad' | 'warn' | 'good'; title?: string };

function noteFor(row: Row, finished: Finished | undefined): Note | null {
  if (row.gross_error) return { text: GROSS, tone: 'bad' };
  if (row.openAppeals > 0) return { text: 'Апелляция ждёт решения' };
  if (row.status === 'failed') {
    if (isBlocked(row)) return { text: 'Не отправлен: персональные данные', tone: 'warn', title: row.error ?? undefined };
    const reason = row.error ?? 'причина не указана';
    const short = reason.length > SHORT_ERROR ? `${reason.slice(0, SHORT_ERROR)}…` : reason;
    return { text: `Сбой: ${short}`, tone: 'warn', title: reason };
  }
  if (finished) {
    return { text: finished.ms === null ? FROM_CACHE : `Оценено за ${fmtDuration(finished.ms)}`, tone: 'good' };
  }
  if (row.flagged) return { text: 'Есть спорные места' };
  if (!row.latest_evaluation_id) return { text: 'Не оценён' };
  return null;
}

function TotalCell({ row, counted }: { row: Row; counted: boolean }) {
  const shown = useCountUp(row.total, { fromZero: counted });
  if (row.total === null) return <span className="drow__total" data-dim>—</span>;
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
      <span />
      <span className="drow__note">
        <span className="drow-stage">
          <Spinner />
          <Swap id={label}>{label}</Swap>
        </span>
      </span>
    </>
  );
}

type RowProps = {
  row: Row;
  progress: Progress | null;
  finished: Finished | undefined;
  entering: boolean;
  onEvaluate: (ids: string[]) => void;
};

function DialogRow({ row, progress, finished, entering, onEvaluate }: RowProps) {
  const navigate = useNavigate();
  const appeal = row.appeal;
  const params = appeal ? `?criterion=${encodeURIComponent(appeal.criterion_id)}&run=${encodeURIComponent(appeal.evaluation_id)}` : '';
  const href = `/conversations/${encodeURIComponent(row.id)}`;
  const note = noteFor(row, finished);
  const stop = (run: () => void) => (event: MouseEvent) => {
    event.stopPropagation();
    run();
  };
  // One clear next step per row, the same priority as the note beside it.
  const action = progress
    ? null
    : row.openAppeals > 0
      ? { label: 'Рассмотреть апелляцию', icon: Gavel, run: () => navigate(`${href}${params}`) }
      : row.status === 'failed' && !isBlocked(row)
        ? { label: 'Оценить повторно', icon: RotateCw, run: () => onEvaluate([row.id]) }
        : !row.latest_evaluation_id
          ? { label: 'Оценить', icon: Play, run: () => onEvaluate([row.id]) }
          : null;
  const time = progress || finished ? 'только что' : fmtRelative(row.evaluatedAt);
  const cells = (
    <div
      className="drow"
      data-link
      data-run={progress ? '' : undefined}
      data-settled={finished && !progress ? '' : undefined}
      onClick={() => navigate(href)}
    >
      <span className="drow__who">
        <Link className="drow__id" to={href} onClick={(event) => event.stopPropagation()}>{row.id}</Link>
        {time && <span className="drow__time" data-now={progress || finished ? '' : undefined}>{time}</span>}
      </span>
      <span><SetTag groupId={row.group_id} /></span>
      <ChannelMark channel={row.channel} language={row.language} />
      {progress ? (
        <RunningCells progress={progress} />
      ) : (
        <>
          <TotalCell row={row} counted={Boolean(finished)} />
          <span>{row.verdict && <span className="verdict" data-verdict={row.verdict.id}>{row.verdict.name}</span>}</span>
          <span className="drow__note" data-tone={note?.tone} title={note?.title}>
            {note && <span>{note.text}</span>}
          </span>
        </>
      )}
      <span className="drow__act">
        {action && (
          <button type="button" className="icon-action" data-tone="go" aria-label={action.label} title={action.label} onClick={stop(action.run)}>
            <action.icon size={17} strokeWidth={1.75} />
          </button>
        )}
        <button type="button" className="icon-action" aria-label="Открыть разбор" title="Открыть разбор" onClick={stop(() => navigate(href))}>
          <ArrowRight size={17} strokeWidth={1.75} />
        </button>
      </span>
    </div>
  );
  return entering ? <div className="row-enter"><div>{cells}</div></div> : cells;
}

function SortHead({ sort, id, label, onSort, end }: { sort: Sort; id: Sort['key']; label: string; onSort: (next: Sort) => void; end?: boolean }) {
  const active = sort.key === id;
  const Arrow = sort.descending ? ArrowDown : ArrowUp;
  return (
    <span className={end ? 'justify-self-end' : undefined}>
      <button
        type="button"
        data-on={active || undefined}
        aria-label={`Сортировать: ${label}`}
        onClick={() => onSort({ key: id, descending: active ? !sort.descending : true })}
      >
        {label}
        {active && <Arrow size={14} strokeWidth={1.75} />}
      </button>
    </span>
  );
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
  const openAppeals = useAsync(() => api.listAppeals({ status: 'open' }), [revision]);
  const exported = useAsync(() => api.exportResults(), [revision]);
  const sheets = useAsync(
    async (): Promise<ChecklistVersion[]> => Promise.all((await api.listChecklists()).map((item) => api.getChecklist(item.checklist_id))),
    [revision],
  );
  const [tab, setTab] = useState<Tab>('all');
  const [sort, setSort] = useState<Sort>({ key: 'when', descending: true });
  const [verdict, setVerdict] = useState<VerdictId | null>(null);
  const [appealOwners, setAppealOwners] = useState<Record<string, string>>({});
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

  // An appeal can sit on an older run of a dialogue, so its owner is not always in the summary.
  useEffect(() => {
    const latest = new Set(items.map((item) => item.latest_evaluation_id));
    for (const appeal of appealList) {
      if (latest.has(appeal.evaluation_id) || appealOwners[appeal.evaluation_id]) continue;
      api.getEvaluation(appeal.evaluation_id).then(
        (run) => setAppealOwners((current) => ({ ...current, [run.id]: run.conversation_id })),
        () => undefined,
      );
    }
  }, [items, appealList, appealOwners]);

  const ownerOf = useCallback(
    (appeal: Appeal) => items.find((item) => item.latest_evaluation_id === appeal.evaluation_id)?.id ?? appealOwners[appeal.evaluation_id] ?? null,
    [items, appealOwners],
  );

  const rows = useMemo(() => {
    const built = items.map((item) => toRow(item, runs[item.id], appealList.filter((appeal) => ownerOf(appeal) === item.id)));
    const direction = sort.descending ? 1 : -1;
    const rank = (row: Row) => (fresh.has(row.id) ? 2 : row.evaluatedAt ? 1 : 0);
    return built.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(b) - rank(a);
      // A dialogue without a total stays below the others in either direction.
      if (sort.key === 'total' && (a.total === null) !== (b.total === null)) {
        return a.total === null ? 1 : -1;
      }
      const order = sort.key === 'total'
        ? (b.total ?? 0) - (a.total ?? 0)
        : (b.evaluatedAt ?? '').localeCompare(a.evaluatedAt ?? '');
      return order * direction || a.id.localeCompare(b.id);
    });
  }, [items, runs, appealList, ownerOf, fresh, sort]);

  const needle = search.trim().toLowerCase();
  const countOf = (id: Tab) => rows.filter(TAB_FILTERS[id]).length;
  const shown = rows
    .filter(TAB_FILTERS[tab])
    .filter((row) => !verdict || row.verdict?.id === verdict)
    .filter((row) => !needle || row.id.toLowerCase().includes(needle));

  const totals = rows.flatMap((row) => (row.total === null ? [] : [row.total]));
  const average = totals.length ? totals.reduce((sum, value) => sum + value, 0) / totals.length : null;
  const verdictCounts = Object.fromEntries(
    VERDICTS.map((item) => [item.id, rows.filter((row) => row.verdict?.id === item.id).length]),
  ) as Record<VerdictId, number>;
  const grossCount = countOf('gross');
  const failedRows = rows.filter(TAB_FILTERS.failed);
  const retryable = failedRows.filter((row) => !isBlocked(row)).map((row) => row.id);
  const evaluatedCount = rows.filter((row) => row.status === 'done').length;
  const failedJobs = jobs.filter(({ job, pollError }) => pollError || (job.status === 'failed' && !job.evaluation_ids.length));
  const pick = (next: Tab) => {
    setTab(tab === next ? 'all' : next);
    setVerdict(null);
  };

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
      await evaluate(added);
    },
    [evaluate, reloadList],
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
      <h1 className="sr-only">Диалоги</h1>
      <Panel className="overview">
        <div className="tiles">
          {(
            [
              { id: 'waiting', icon: CheckCircle2, label: 'Оценено', value: evaluatedCount, of: rows.length, tone: 'good' },
              { id: 'gross', icon: ShieldAlert, label: 'Грубые нарушения', value: grossCount, tone: grossCount ? 'bad' : undefined },
              { id: 'appeals', icon: Gavel, label: 'Апелляции', value: countOf('appeals'), tone: undefined },
              { id: 'failed', icon: TriangleAlert, label: 'Сбои оценки', value: failedRows.length, tone: failedRows.length ? 'warn' : undefined },
              { id: 'disputed', icon: AlertTriangle, label: 'Спорные места', value: countOf('disputed'), tone: undefined },
            ] as const
          ).map((tile) => (
            <button key={tile.id} type="button" className="tile" data-tone={tile.tone} aria-pressed={tab === tile.id} onClick={() => pick(tile.id)}>
              <tile.icon size={20} strokeWidth={1.75} aria-hidden />
              <span className="tile__label">{tile.label}</span>
              <span className="tile__value">{tile.value}{'of' in tile && <small>из {tile.of}</small>}</span>
            </button>
          ))}
        </div>
        <div className="overview__end">
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
          <Button variant="primary" size="large" onClick={() => fileInput.current?.click()}>
            <Plus size={18} strokeWidth={2} aria-hidden /> Загрузить диалог
          </Button>
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

      <div className="dash">
        <div className="dash__main">
          <div className="tabs-row">
            <div role="tablist" className="tabs">
              {[...MAIN_TABS, ...(MAIN_TABS.includes(tab) ? [] : [tab])].map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  className="tab"
                  onClick={() => {
                    setTab(id);
                    setVerdict(null);
                  }}
                >
                  {TAB_LABELS[id]} {countOf(id)}
                </button>
              ))}
              {verdict && (
                <button type="button" className="tab" aria-selected onClick={() => setVerdict(null)}>
                  {VERDICTS.find((item) => item.id === verdict)?.name} {verdictCounts[verdict]} ×
                </button>
              )}
            </div>
            {tab === 'failed' && retryable.length > 0 && <Button variant="text" onClick={() => evaluate(retryable)}>Повторить все</Button>}
            {tab === 'waiting' && notEvaluated.length > 0 && <Button variant="text" onClick={() => evaluate(notEvaluated)}>Оценить все</Button>}
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
              <SortHead sort={sort} id="when" label="Диалог, время" onSort={setSort} />
              <span>Набор</span>
              <span>Канал</span>
              <SortHead sort={sort} id="total" label="Итог" onSort={setSort} end />
              <span>Оценка</span>
              <span>Отметка</span>
              <span className="justify-self-end">Действия</span>
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
                    progress={progressFor(jobs, row.id, row.latest_evaluation_id)}
                    finished={finished[row.id]}
                    entering={Date.now() - (fresh.get(row.id) ?? 0) < ENTER_MS}
                    onEvaluate={evaluate}
                  />
                ))
              )}
            </div>
          </Panel>
        </div>

        <StatsPanel
          average={average}
          counts={verdictCounts}
          active={verdict}
          onVerdict={setVerdict}
          results={exported.data}
          sheets={sheets.data ?? []}
        />
      </div>
    </>
  );
}
