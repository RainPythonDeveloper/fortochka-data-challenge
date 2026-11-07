import { useCallback, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type {
  Appeal,
  ChecklistVersion,
  ConversationDetail,
  Criterion,
  CriterionResult,
  EvaluationRun,
  ScoreSummary,
} from '../api/types';
import { CompareDialog } from '../components/CompareDialog';
import { DecisionCompare } from '../components/DecisionCompare';
import { RunEvaluation } from '../components/RunEvaluation';
import { Transcript, type TurnFocus } from '../components/Transcript';
import { Badge, Banner, Button, EmptyState, ErrorState, Field, LoadingState, Modal, inputClass } from '../components/ui';
import { host } from '../host/hostAdapter';
import {
  answerLabel,
  answerTone,
  channelLabel,
  criterionTitle,
  fmtNumber,
  isStubRun,
  reasonLabel,
  reviewNotes,
  runLabel,
} from '../lib/format';
import { useJobs } from '../lib/jobs';
import { useAsync } from '../lib/useAsync';

function nullTotalReason(run: EvaluationRun, score: ScoreSummary): string {
  if (run.status === 'failed') return 'Оценка завершилась сбоем, сбой не считается нулём.';
  if (score.is_partial) {
    const names = score.missing_criteria.map((id) => criterionTitle(run.checklist, id)).join(', ');
    return `Нет результата по критериям: ${names}. Их вес не перераспределён.`;
  }
  return 'Нет применимых критериев с весом.';
}

function TotalBox({ label, run, score, primary }: { label: string; run: EvaluationRun; score: ScoreSummary; primary?: boolean }) {
  return (
    <div data-testid={primary ? 'final-total' : 'original-total'} className="min-w-36">
      <p className="text-xs text-stone-500">{label}</p>
      {score.total !== null ? (
        <p className={`font-semibold tabular-nums leading-tight ${primary ? 'text-2xl text-brand-800' : 'text-lg text-stone-500'}`}>
          {fmtNumber(score.total)}
        </p>
      ) : (
        <>
          <p className="font-semibold text-amber-800">Итог не рассчитан</p>
          {score.partial_total !== null && run.status !== 'failed' && (
            <p className="text-xs text-stone-700">
              Частичный результат: <b className="tabular-nums">{fmtNumber(score.partial_total)}</b> (нижняя граница, не итог)
            </p>
          )}
          <p className="max-w-80 text-xs text-stone-600">{nullTotalReason(run, score)}</p>
        </>
      )}
    </div>
  );
}

function RunBanners({ run }: { run: EvaluationRun }) {
  const gross = run.final_score.gross_error;
  const clearedByDecision = run.score.gross_error && !gross;
  const reasons = reviewNotes(run.review_reasons);
  const attemptErrors = [...new Set(run.log.attempts.flatMap((attempt) => attempt.errors))];
  return (
    <div className="space-y-2">
      {gross && (
        <Banner tone="bad" title="Грубая ошибка">
          {run.final_score.gross_error_criteria.map((id) => criterionTitle(run.checklist, id)).join(', ')}. Флаг не влияет на итог и показан отдельно.
        </Banner>
      )}
      {clearedByDecision && <Banner tone="info" title="Грубая ошибка снята решением проверяющего" />}
      {run.status === 'failed' && (
        <Banner tone="warn" title="Оценка не выполнена">{run.error || attemptErrors.join('; ') || 'Причина не указана.'}</Banner>
      )}
      {isStubRun(run) && (
        <Banner tone="warn" title="Результат провайдера-заглушки">Реальная модель не вызывалась, баллы только для проверки интерфейса.</Banner>
      )}
      {run.review_status === 'flagged' && reasons.length > 0 && (
        <Banner tone="warn" title="Нужна проверка">{reasons.map(reasonLabel).join('; ')}</Banner>
      )}
    </div>
  );
}

function ScorePanel({ run }: { run: EvaluationRun }) {
  const changed = run.score.total !== run.final_score.total || run.score.partial_total !== run.final_score.partial_total;
  // A missing criterion stays in the section denominator, so its numbers are a lower bound.
  const incomplete = new Set(
    (run.checklist?.criteria ?? []).filter((item) => run.final_score.missing_criteria.includes(item.id)).map((item) => item.section),
  );
  return (
    <section className="rounded border border-line bg-white p-3">
      <div className="flex flex-wrap items-start gap-6">
        {changed && <TotalBox label="Исходный итог" run={run} score={run.score} />}
        <TotalBox label={changed ? 'Финальный итог' : 'Итог'} run={run} score={run.final_score} primary />
        {run.status === 'done' && <table className="ml-auto text-xs">
          <tbody>
            {run.final_score.sections.map((section) => (
              <tr key={section.section_id}>
                <td className="pr-3 text-stone-600">{section.title}</td>
                <td className="text-right font-medium tabular-nums">
                  {section.percent === null ? (
                    section.flags.length ? <Badge tone="bad">Флаг</Badge> : '—'
                  ) : (
                    `${fmtNumber(section.earned)} / ${fmtNumber(section.possible)}`
                  )}
                </td>
                <td className="pl-2 text-right tabular-nums text-stone-500">
                  {incomplete.has(section.section_id) ? <Badge tone="warn">Неполно</Badge> : section.percent !== null && `${fmtNumber(section.percent)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>}
      </div>
    </section>
  );
}

type CriterionCardProps = {
  run: EvaluationRun;
  criterion: Criterion;
  appeals: Appeal[];
  onEvidence: (turnIndex: number) => void;
  onRange: (result: CriterionResult, criterion: Criterion) => void;
  onAppeal: (criterionId: string) => void;
};

function CriterionCard({ run, criterion, appeals, onEvidence, onRange, onAppeal }: CriterionCardProps) {
  const result = run.final_results.find((item) => item.criterion_id === criterion.id);
  const original = run.results.find((item) => item.criterion_id === criterion.id);
  const score = run.final_score.criteria.find((item) => item.criterion_id === criterion.id);
  if (!result) return null;
  const openAppeal = appeals.find((item) => item.status === 'open');
  const decided = appeals.filter((item) => item.status === 'decided');
  const hasRange = result.reviewed_range !== null || result.expected_at_turn !== null;
  const isNa = result.status === 'not_applicable';

  return (
    <article data-criterion={criterion.id} className="rounded border border-line bg-white p-2.5">
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold leading-snug">{criterion.title}</h3>
          <p className="text-xs text-stone-500 tabular-nums">
            {criterion.scored ? (
              <>
                Вес {fmtNumber(criterion.weight)}, эффективный {fmtNumber(score?.effective_weight)}
              </>
            ) : (
              'Без баллов, флаг показывается отдельно'
            )}
          </p>
        </div>
        <Badge tone={answerTone(criterion, result.status, result.answer)}>{answerLabel(criterion, result.status, result.answer)}</Badge>
        {criterion.scored && (
          <span className="w-16 text-right font-semibold tabular-nums" title="Баллы">
            {fmtNumber(score?.points)}
            <span className="font-normal text-stone-400"> б.</span>
          </span>
        )}
      </header>

      {isNa ? (
        <p className="mt-1.5 rounded bg-stone-100 px-2 py-1">
          <span className="font-medium">Причина N/A: </span>
          {result.justification}
          {criterion.na_when && <span className="block text-xs text-stone-500">Условие: {criterion.na_when}</span>}
        </p>
      ) : (
        <p className="mt-1.5">{result.justification}</p>
      )}

      {result.evidence.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {result.evidence.map((item, position) => (
            <li key={position}>
              <button
                type="button"
                data-evidence-turn={item.turn_index}
                onClick={() => onEvidence(item.turn_index)}
                className="w-full rounded border-l-2 border-brand-500 bg-brand-50 px-2 py-0.5 text-left hover:bg-brand-100"
              >
                <span className="text-xs font-medium text-brand-700">Реплика #{item.turn_index}: </span>«{item.quote}»
              </button>
            </li>
          ))}
        </ul>
      )}

      {hasRange && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-950">
          {result.reviewed_range && (
            <span>Проверен участок: реплики #{result.reviewed_range.from_turn}–#{result.reviewed_range.to_turn}</span>
          )}
          {result.expected_at_turn !== null && <span>Ожидалось у реплики #{result.expected_at_turn}</span>}
          <Button variant="ghost" className="!h-5" onClick={() => onRange(result, criterion)}>Показать в диалоге</Button>
        </div>
      )}

      {reviewNotes(result.review_flags).length > 0 && (
        <p className="mt-1.5 text-xs text-amber-800">
          Флаг проверки: {reviewNotes(result.review_flags).map(reasonLabel).join('; ')}
        </p>
      )}

      {decided.map((appeal) => (
        <div key={appeal.id} className="mt-2">
          <p className="mb-1 text-xs text-stone-500">Апелляция: {appeal.comment}</p>
          <DecisionCompare run={run} appeal={appeal} />
        </div>
      ))}
      {decided.length > 0 && original && original.justification !== result.justification && (
        <p className="mt-1 text-xs text-stone-500">Исходное объяснение: {original.justification}</p>
      )}

      <footer className="mt-1.5 flex items-center justify-end gap-2">
        {openAppeal ? (
          <span className="mr-auto text-xs text-amber-800">Апелляция на рассмотрении: {openAppeal.comment}</span>
        ) : (
          run.status === 'done' && (
            <Button variant="ghost" className="!h-6" onClick={() => onAppeal(criterion.id)}>Оспорить</Button>
          )
        )}
      </footer>
    </article>
  );
}

function RunLogDetails({ run }: { run: EvaluationRun }) {
  const { log } = run;
  const rows: [string, string][] = [
    ['run_id', log.run_id],
    ['Чек-лист', run.checklist ? `${run.checklist_id}, версия ${run.checklist_version}` : 'Не выбран'],
    ['content_hash', log.content_hash],
    ['checklist_hash', log.checklist_hash],
    ['prompt_hash', log.prompt_hash || '—'],
    ['Pipeline', log.pipeline],
    ['Кэш', log.cache_hit ? `Результат взят из кэша${log.cached_from ? `, запуск ${log.cached_from}` : ''}` : 'Новый запуск'],
    ['Оценщик', log.evaluator ? JSON.stringify(log.evaluator) : '—'],
    ['Задержка', log.latency_ms === null ? '—' : `${fmtNumber(log.latency_ms)} мс`],
    ['Стоимость', log.cost_usd === null ? '—' : `$${log.cost_usd}`],
  ];
  return (
    <details className="rounded border border-line bg-white p-2.5">
      <summary className="font-medium text-stone-700">Журнал запуска</summary>
      <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-x-2 text-xs">
        {rows.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-stone-500">{key}</dt>
            <dd className="break-all font-mono">{value}</dd>
          </div>
        ))}
      </dl>
      <table className="mt-2 w-full text-xs">
        <thead className="text-left text-stone-500">
          <tr>
            <th className="font-medium">Попытка</th>
            <th className="font-medium">Провайдер и модель</th>
            <th className="font-medium">Токены</th>
            <th className="font-medium">Стоимость</th>
            <th className="font-medium">Результат</th>
          </tr>
        </thead>
        <tbody>
          {log.attempts.map((attempt, position) => (
            <tr key={position} className="align-top">
              <td>{attempt.attempt}, {attempt.role}</td>
              <td>{attempt.provider} / {attempt.model}</td>
              <td className="tabular-nums">{attempt.input_tokens ?? '—'} / {attempt.output_tokens ?? '—'}</td>
              <td className="tabular-nums">{attempt.cost_usd === null ? '—' : `$${attempt.cost_usd}`}</td>
              <td>{attempt.valid ? 'Принят' : `Отклонён: ${attempt.errors.join('; ')}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function AppealDialog({
  run,
  checklist,
  blocked,
  initial,
  onClose,
  onSaved,
}: {
  run: EvaluationRun;
  checklist: ChecklistVersion;
  blocked: Set<string>;
  initial: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [criterionId, setCriterionId] = useState(initial);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createAppeal({ evaluation_id: run.id, criterion_id: criterionId, comment: comment.trim() });
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Апелляция не сохранена');
      setBusy(false);
    }
  };

  return (
    <Modal title="Апелляция" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Критерий">
          <select className={inputClass} value={criterionId} onChange={(event) => setCriterionId(event.target.value)}>
            {checklist.criteria.map((criterion) => (
              <option key={criterion.id} value={criterion.id} disabled={blocked.has(criterion.id)}>
                {criterion.title}
                {blocked.has(criterion.id) ? ' (уже на рассмотрении)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Комментарий">
          <textarea
            autoFocus
            rows={4}
            className={inputClass}
            placeholder="С чем вы не согласны и почему"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        </Field>
        {error && <p role="alert" className="text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" disabled={busy || !comment.trim() || !criterionId || blocked.has(criterionId)} onClick={save}>
            {busy ? 'Сохранение…' : 'Сохранить апелляцию'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function EvaluationPanel({
  run,
  conversation,
  onFocus,
}: {
  run: EvaluationRun;
  conversation: ConversationDetail;
  onFocus: (focus: Omit<TurnFocus, 'nonce'> | string) => void;
}) {
  const appeals = useAsync(() => api.listAppeals({ evaluation_id: run.id }), [run.id]);
  const [appealFor, setAppealFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Kept on purpose: a backend without the evaluation_id parameter ignores it.
  const runAppeals = useMemo(
    () => (appeals.data ?? []).filter((item) => item.evaluation_id === run.id),
    [appeals.data, run.id],
  );
  const blocked = useMemo(
    () => new Set(runAppeals.filter((item) => item.status === 'open').map((item) => item.criterion_id)),
    [runAppeals],
  );
  const known = useMemo(() => new Set(conversation.turns.map((turn) => turn.index)), [conversation.turns]);

  const showEvidence = (turnIndex: number) => {
    if (!known.has(turnIndex)) return onFocus(`Реплика #${turnIndex} не найдена в этом снимке диалога.`);
    onFocus({ target: turnIndex, marked: [turnIndex], expected: null });
  };

  const showRange = (result: CriterionResult, criterion: Criterion) => {
    const range = result.reviewed_range;
    const marked = range ? [...known].filter((index) => index >= range.from_turn && index <= range.to_turn) : [];
    const target = result.expected_at_turn ?? marked[0];
    if (target === undefined || !known.has(target)) return onFocus('Указанного участка нет в этом снимке диалога.');
    onFocus({
      target,
      marked,
      expected: result.expected_at_turn !== null ? { turn: result.expected_at_turn, label: criterion.title } : null,
    });
  };

  const checklist = run.checklist;
  const defaultCriterion = checklist?.criteria.find((item) => !blocked.has(item.id))?.id ?? '';

  return (
    <div className="space-y-2 p-2">
      <RunBanners run={run} />
      <ScorePanel run={run} />
      {appeals.error && <p role="alert" className="text-red-700">Апелляции не загрузились: {appeals.error}</p>}
      {notice && <p role="status" className="rounded bg-brand-50 px-2 py-1 text-brand-800">{notice}</p>}

      {run.status === 'done' && checklist && (
        <div className="flex justify-end">
          <Button onClick={() => setAppealFor(defaultCriterion)} disabled={!defaultCriterion}>Подать апелляцию</Button>
        </div>
      )}

      {run.final_results.length === 0 || !checklist ? (
        <EmptyState title="Результатов по критериям нет">Запустите оценку повторно.</EmptyState>
      ) : (
        checklist.sections.map((section) => {
          const criteria = checklist.criteria.filter((item) => item.section === section.id);
          if (!criteria.length) return null;
          return (
            <section key={section.id} className="space-y-1.5">
              <h2 className="pt-1 text-xs font-semibold uppercase tracking-wide text-stone-500">{section.title}</h2>
              {criteria.map((criterion) => (
                <CriterionCard
                  key={criterion.id}
                  run={run}
                  criterion={criterion}
                  appeals={runAppeals.filter((item) => item.criterion_id === criterion.id)}
                  onEvidence={showEvidence}
                  onRange={showRange}
                  onAppeal={setAppealFor}
                />
              ))}
            </section>
          );
        })
      )}

      <RunLogDetails run={run} />

      {appealFor !== null && checklist && (
        <AppealDialog
          run={run}
          checklist={checklist}
          blocked={blocked}
          initial={appealFor}
          onClose={() => setAppealFor(null)}
          onSaved={() => {
            setAppealFor(null);
            setNotice('Апелляция сохранена и передана в очередь проверки.');
            appeals.reload();
          }}
        />
      )}
    </div>
  );
}

export function ConversationPage() {
  const { id = '' } = useParams();
  // A new id starts from clean state: no stale run choice or focus from the previous dialogue.
  return <ConversationView key={id} id={id} />;
}

function ConversationView({ id }: { id: string }) {
  const { revision } = useJobs();
  const conversation = useAsync(() => api.getConversation(id), [id, revision]);
  const history = useAsync(() => api.listEvaluations(id), [id, revision]);
  const [chosenRun, setChosenRun] = useState<string | null>(null);
  const [focus, setFocus] = useState<TurnFocus | null>(null);
  const [focusError, setFocusError] = useState<string | null>(null);
  const [audioNotice, setAudioNotice] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);

  const runId = chosenRun ?? conversation.data?.latest_evaluation_id ?? null;
  const run = useAsync(() => (runId ? api.getEvaluation(runId) : Promise.resolve(null)), [runId, revision]);

  const onFocus = useCallback((next: Omit<TurnFocus, 'nonce'> | string) => {
    if (typeof next === 'string') {
      setFocusError(next);
      return;
    }
    setFocusError(null);
    setFocus((current) => ({ ...next, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  if (conversation.error) return <ErrorState message={conversation.error} onRetry={conversation.reload} />;
  if (!conversation.data) return <LoadingState label="Загружаем диалог…" />;
  const detail = conversation.data;
  const doneRuns = (history.data ?? []).filter((item) => item.status === 'done');

  const openAudio = () => {
    const url = api.audioUrl(detail.id);
    if (url) host.openExternal(url);
    else setAudioNotice('В режиме моков записи нет. С backend кнопка откроет GET /conversations/{id}/audio.');
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-white px-4 py-1.5">
        <Link to="/conversations" className="text-brand-700 hover:underline">← Диалоги</Link>
        <h1 className="font-semibold">{detail.id}</h1>
        <Badge>{channelLabel(detail.channel)}</Badge>
        <Badge>{detail.language}</Badge>
        <span className="text-stone-500">Реплик: {detail.turn_count}</span>
        {detail.has_audio && <Button onClick={openAudio}>Открыть запись</Button>}
        {audioNotice && <span role="status" className="text-amber-800">{audioNotice}</span>}
        {(history.data?.length ?? 0) > 0 && (
          <select
            aria-label="Запуск оценки"
            className={`${inputClass} !w-80`}
            value={runId ?? ''}
            onChange={(event) => setChosenRun(event.target.value)}
          >
            {history.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {runLabel(item)}
              </option>
            ))}
          </select>
        )}
        {doneRuns.length >= 2 && <Button onClick={() => setComparing(true)}>Сравнить запуски</Button>}
        <div className="ml-auto">
          <RunEvaluation conversationIds={[detail.id]} channels={[detail.channel]} buttonLabel="Оценить" />
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section aria-label="Транскрипт" className="min-h-0 overflow-y-auto border-r border-line">
          {focusError && <p role="alert" className="m-2 rounded bg-amber-50 p-2 text-amber-900">{focusError}</p>}
          <Transcript turns={detail.turns} focus={focus} />
        </section>
        <section aria-label="Результат оценки" className="min-h-0 overflow-y-auto">
          {!runId ? (
            <EmptyState title="Диалог ещё не оценён">Выберите чек-лист вверху и нажмите «Оценить».</EmptyState>
          ) : run.error ? (
            <ErrorState message={run.error} onRetry={run.reload} />
          ) : !run.data ? (
            <LoadingState label="Загружаем оценку…" />
          ) : (
            <EvaluationPanel key={run.data.id} run={run.data} conversation={detail} onFocus={onFocus} />
          )}
        </section>
      </div>
      {comparing && <CompareDialog runs={doneRuns} onClose={() => setComparing(false)} />}
    </div>
  );
}
