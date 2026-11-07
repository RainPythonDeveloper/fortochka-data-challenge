import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { Answer, Appeal, Criterion, DecisionCreate, EvaluationRun } from '../api/types';
import { DecisionCompare } from '../components/DecisionCompare';
import { TurnRow } from '../components/Transcript';
import { Badge, Button, EmptyState, ErrorState, Field, LoadingState, inputClass } from '../components/ui';
import { host } from '../host/hostAdapter';
import { answerLabel, answerTone, criterionTitle, fmtDate, fmtNumber } from '../lib/format';
import { useAsync } from '../lib/useAsync';

const FRAGMENT_MARGIN = 2;
const REVIEWER_KEY = 'cqa.reviewer';

function rememberedReviewer(): string {
  try {
    return host.currentUserName() ?? localStorage.getItem(REVIEWER_KEY) ?? '';
  } catch {
    return host.currentUserName() ?? '';
  }
}

function rememberReviewer(name: string) {
  try {
    localStorage.setItem(REVIEWER_KEY, name);
  } catch {
    // Storage may be blocked inside a host frame. The field is simply empty next time.
  }
}

const currentValue = (run: EvaluationRun, criterionId: string) => {
  const result = run.final_results.find((item) => item.criterion_id === criterionId);
  if (result?.status === 'not_applicable') return 'na';
  return result?.status === 'assessed' ? String(result.answer) : '';
};

function DecisionForm({ appeal, run, criterion, onDecided }: { appeal: Appeal; run: EvaluationRun; criterion: Criterion; onDecided: () => void }) {
  const [mode, setMode] = useState<DecisionCreate['decision']>('confirm');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [reviewer, setReviewer] = useState(rememberedReviewer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options: { value: string; label: string }[] = [
    ...(criterion.type === 'boolean'
      ? (['yes', 'no'] as const).map((answer) => ({ value: answer, label: answerLabel(criterion, 'assessed', answer) }))
      : criterion.levels.map((level) => ({ value: String(level.value), label: `${level.value}: ${level.text}` }))),
    ...(criterion.allow_na ? [{ value: 'na', label: `N/A: ${criterion.na_when ?? ''}` }] : []),
  ];

  const unchanged = mode === 'change' && value === currentValue(run, criterion.id);
  const ready = reason.trim() && reviewer.trim() && (mode === 'confirm' || (value && !unchanged));

  const submit = async () => {
    const answer: Answer = value === 'yes' || value === 'no' ? value : value === 'na' ? null : Number(value);
    const payload: DecisionCreate = {
      decision: mode,
      reason: reason.trim(),
      reviewer: reviewer.trim(),
      ...(mode === 'change'
        ? { new_status: value === 'na' ? ('not_applicable' as const) : ('assessed' as const), new_answer: answer }
        : {}),
    };
    setBusy(true);
    setError(null);
    try {
      await api.decideAppeal(appeal.id, payload);
      rememberReviewer(reviewer.trim());
      onDecided();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Решение не сохранено');
      setBusy(false);
    }
  };

  return (
    <section className="rounded border border-line bg-white p-3">
      <h2 className="mb-2 font-semibold">Решение</h2>
      <div className="mb-2 flex gap-4">
        <label className="flex items-center gap-1">
          <input type="radio" name="decision" checked={mode === 'confirm'} onChange={() => setMode('confirm')} />
          Подтвердить оценку
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" name="decision" checked={mode === 'change'} onChange={() => setMode('change')} />
          Изменить оценку
        </label>
      </div>
      <div className="space-y-2">
        {mode === 'change' && (
          <Field label="Новая оценка">
            <select className={inputClass} value={value} onChange={(event) => setValue(event.target.value)}>
              <option value="">Выберите значение</option>
              {options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            {unchanged && <span className="text-xs text-amber-800">Значение совпадает с текущим. Для этого есть подтверждение.</span>}
          </Field>
        )}
        <Field label="Причина решения (обязательно)">
          <textarea rows={3} className={inputClass} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <Field label="Проверяющий">
          <input className={inputClass} value={reviewer} onChange={(event) => setReviewer(event.target.value)} />
        </Field>
        {error && <p role="alert" className="text-red-700">{error}</p>}
        <Button variant="primary" disabled={busy || !ready} onClick={submit}>
          {busy ? 'Сохранение…' : 'Сохранить решение'}
        </Button>
      </div>
    </section>
  );
}

function AppealDetail({ appeal, onDecided }: { appeal: Appeal; onDecided: () => void }) {
  const run = useAsync(() => api.getEvaluation(appeal.evaluation_id), [appeal.id, appeal.status]);
  const conversationId = run.data?.conversation_id;
  const conversation = useAsync(
    () => (conversationId ? api.getConversation(conversationId) : Promise.resolve(null)),
    [conversationId],
  );

  if (run.error) return <ErrorState message={run.error} onRetry={run.reload} />;
  if (!run.data) return <LoadingState label="Загружаем спорную оценку…" />;

  const data = run.data;
  const criterion = data.checklist.criteria.find((item) => item.id === appeal.criterion_id);
  const original = data.results.find((item) => item.criterion_id === appeal.criterion_id);
  const originalScore = data.score.criteria.find((item) => item.criterion_id === appeal.criterion_id);
  if (!criterion || !original) return <ErrorState message="Критерия апелляции нет в запуске оценки." />;

  const evidenceTurns = original.evidence.map((item) => item.turn_index);
  const anchors = [
    ...evidenceTurns,
    ...(original.reviewed_range ? [original.reviewed_range.from_turn, original.reviewed_range.to_turn] : []),
    ...(original.expected_at_turn !== null ? [original.expected_at_turn] : []),
  ];
  const turns = conversation.data?.turns ?? [];
  const from = anchors.length ? Math.min(...anchors) - FRAGMENT_MARGIN : -Infinity;
  const to = anchors.length ? Math.max(...anchors) + FRAGMENT_MARGIN : Infinity;
  const fragment = turns.filter((turn) => turn.index >= from && turn.index <= to);

  return (
    <div className="space-y-3">
      <section className="rounded border border-line bg-white p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">{criterion.title}</h2>
            <p className="text-xs text-stone-500">
              <Link className="text-brand-700 hover:underline" to={`/conversations/${encodeURIComponent(data.conversation_id)}`}>
                {data.conversation_id}
              </Link>
              , чек-лист v{data.checklist_version}, подана {fmtDate(appeal.created_at)}
            </p>
          </div>
          <Badge tone={answerTone(criterion, original.status, original.answer)}>
            {answerLabel(criterion, original.status, original.answer)}
          </Badge>
          {criterion.scored && <span className="font-semibold tabular-nums">{fmtNumber(originalScore?.points)} б.</span>}
        </div>
        <p className="mt-2"><span className="font-medium">Объяснение: </span>{original.justification}</p>
        <p className="mt-2 rounded bg-amber-50 px-2 py-1"><span className="font-medium">Комментарий апелляции: </span>{appeal.comment}</p>
        {criterion.yes_when && <p className="mt-2 text-xs text-stone-500">Условие «Да»: {criterion.yes_when}</p>}
        {criterion.prompt && <p className="mt-2 text-xs text-stone-500">{criterion.prompt}</p>}
      </section>

      <section className="rounded border border-line bg-white p-3">
        <h2 className="mb-2 font-semibold">Фрагмент диалога</h2>
        {conversation.error ? (
          <ErrorState message={conversation.error} onRetry={conversation.reload} />
        ) : !conversation.data ? (
          <LoadingState label="Загружаем фрагмент…" />
        ) : (
          <div className="space-y-1">
            {fragment.map((turn) => (
              <TurnRow key={turn.index} turn={turn} marked={evidenceTurns.includes(turn.index)} />
            ))}
          </div>
        )}
      </section>

      {appeal.status === 'open' ? (
        <DecisionForm appeal={appeal} run={data} criterion={criterion} onDecided={onDecided} />
      ) : (
        <section className="space-y-2 rounded border border-line bg-white p-3">
          <DecisionCompare run={data} appeal={appeal} />
          <p>
            Итог диалога: {fmtNumber(data.score.total)} → <b data-testid="review-final-total">{fmtNumber(data.final_score.total)}</b>
          </p>
        </section>
      )}
    </div>
  );
}

export function ReviewPage() {
  const [tab, setTab] = useState<Appeal['status']>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const appeals = useAsync(() => api.listAppeals(), []);

  // The list needs titles, and Appeal carries only ids, so each run is read once.
  const items = useMemo(() => appeals.data ?? [], [appeals.data]);
  const evaluationIds = [...new Set(items.map((item) => item.evaluation_id))];
  const runs = useAsync(
    async () => new Map((await Promise.all(evaluationIds.map((id) => api.getEvaluation(id)))).map((run) => [run.id, run])),
    [evaluationIds.join('|')],
  );

  const visible = items.filter((item) => item.status === tab);
  const openCount = items.filter((item) => item.status === 'open').length;
  const selected = items.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId === null) setSelectedId(items.find((item) => item.status === 'open')?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const switchTab = (next: Appeal['status']) => {
    setTab(next);
    setSelectedId(items.find((item) => item.status === next)?.id ?? null);
  };

  return (
    <div className="mx-auto grid h-full max-w-[1400px] grid-cols-[320px_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-y-auto border-r border-line bg-white">
        <div className="border-b border-line p-3">
          <h1 className="text-base font-semibold">Очередь проверки</h1>
          <div className="mt-2 flex gap-1">
            <Button variant={tab === 'open' ? 'primary' : 'secondary'} onClick={() => switchTab('open')}>Ожидают ({openCount})</Button>
            <Button variant={tab === 'decided' ? 'primary' : 'secondary'} onClick={() => switchTab('decided')}>
              Решённые ({items.length - openCount})
            </Button>
          </div>
        </div>
        {appeals.error ? (
          <ErrorState message={appeals.error} onRetry={appeals.reload} />
        ) : !appeals.data ? (
          <LoadingState />
        ) : !visible.length ? (
          <EmptyState title={tab === 'open' ? 'Спорных оценок нет' : 'Решений пока нет'}>
            {tab === 'open' ? 'Апелляции подаются из карточки диалога.' : undefined}
          </EmptyState>
        ) : (
          <ul>
            {visible.map((item) => {
              const run = runs.data?.get(item.evaluation_id);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className={`block w-full border-b border-stone-100 px-3 py-2 text-left hover:bg-brand-50 ${item.id === selectedId ? 'bg-brand-50' : ''}`}
                  >
                    <span className="block font-medium">{run ? criterionTitle(run.checklist, item.criterion_id) : item.criterion_id}</span>
                    <span className="block text-xs text-stone-500">{run?.conversation_id ?? item.evaluation_id}, {fmtDate(item.created_at)}</span>
                    <span className="mt-0.5 line-clamp-2 block text-xs text-stone-700">{item.comment}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>
      <div className="min-h-0 overflow-y-auto p-3">
        {selected ? (
          <AppealDetail
            key={selected.id}
            appeal={selected}
            onDecided={() => {
              setTab('decided');
              appeals.reload();
            }}
          />
        ) : (
          !appeals.loading && <EmptyState title="Выберите апелляцию в списке" />
        )}
      </div>
    </div>
  );
}
