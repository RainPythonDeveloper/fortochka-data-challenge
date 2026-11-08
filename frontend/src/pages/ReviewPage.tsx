import { Headphones, History } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { ChecklistVersion, ConversationDetail, EvaluationRun, EvaluationSummary } from '../api/types';
import { ChannelMark } from '../components/ChannelMark';
import { CompareDialog } from '../components/CompareDialog';
import { CriteriaList } from '../components/CriteriaList';
import { EvidenceLink } from '../components/EvidenceLink';
import { RerunMenu } from '../components/RerunMenu';
import { RunLogPanel } from '../components/RunLogPanel';
import { ScoreBreakdown } from '../components/ScoreBreakdown';
import { HumanReviewMenu } from '../components/HumanReviewMenu';
import { ScoreBlock } from '../components/ScoreBlock';
import { StageRail } from '../components/StageRail';
import { TurnList, type TurnFocus } from '../components/TurnList';
import { Button, EmptyState, ErrorState, LoadingState, Panel, Tag } from '../components/ui';
import { host } from '../host/hostAdapter';
import { PERSONAL_DATA_FLAG, channelLabel, errorText, isStubRun, languageLabel, visibleFlags } from '../lib/format';
import { progressFor, useJobs } from '../lib/jobs';
import { MOCK_LABEL } from '../lib/labels';
import { reducedMotion } from '../lib/motion';
import { useAsync } from '../lib/useAsync';

const ROW_TOP_GAP = 8;
const UNFOLD_MS = 260;
const SETTLE_MS = 2500;
const REVEAL_MS = 1500;

export function ReviewPage() {
  const { id = '' } = useParams();
  // A new id starts from clean state: no stale run choice or open criterion.
  return <ReviewView key={id} id={id} />;
}

/** The sheet whose criteria stand as placeholders while the first evaluation runs. */
async function sheetForChannel(channel: string): Promise<ChecklistVersion | null> {
  const lists = await api.listChecklists();
  const match = lists.find((item) => item.channels.includes(channel));
  return match ? api.getChecklist(match.checklist_id) : null;
}

function focusFor(run: EvaluationRun | null, criterionId: string | null, nonce: number, turn: number | null): TurnFocus | null {
  const result = criterionId ? run?.final_results.find((item) => item.criterion_id === criterionId) : undefined;
  if (!result) return turn === null ? null : { evidence: [], range: null, target: turn, nonce };
  const target = turn ?? result.evidence[0]?.turn_index ?? result.expected_at_turn ?? result.reviewed_range?.from_turn ?? null;
  return { evidence: result.evidence, range: result.reviewed_range, target, nonce };
}

type RunPanelProps = { detail: ConversationDetail; run: EvaluationRun | null; retry: () => void; busy: boolean; failure: string | null };

function NoResult({ detail, run, retry, busy, failure }: RunPanelProps) {
  if (run?.status === 'failed') {
    const blocked = run.review_reasons.includes(PERSONAL_DATA_FLAG);
    return (
      <EmptyState title={blocked ? 'Не отправлен: персональные данные' : 'Сбой оценки'}>
        <p className="mb-3">{run.error ?? 'Причина не указана.'}</p>
        <Button disabled={busy} onClick={retry}>Повторить</Button>
        {failure && <p role="alert" className="notice mt-2" data-tone="bad">{failure}</p>}
      </EmptyState>
    );
  }
  return (
    <EmptyState title={`${channelLabel(detail.channel)} ещё не оценён`}>
      <Button variant="primary" disabled={busy} onClick={retry}>Оценить</Button>
      {failure && <p role="alert" className="notice mt-2" data-tone="bad">{failure}</p>}
    </EmptyState>
  );
}

function ReviewView({ id }: { id: string }) {
  const { jobs, revision, track } = useJobs();
  const [params] = useSearchParams();
  const conversation = useAsync(() => api.getConversation(id), [id, revision]);
  const history = useAsync(() => api.listEvaluations(id), [id, revision]);
  const [chosenRun, setChosenRun] = useState<string | null>(params.get('run'));
  const [openId, setOpenId] = useState<string | null>(params.get('criterion'));
  const [reviewRequest, setReviewRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [turnJump, setTurnJump] = useState<{ turn: number; nonce: number } | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [audioNotice, setAudioNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const progress = progressFor(jobs, id, conversation.data?.latest_evaluation_id);
  const running = Boolean(progress);
  // In a batch this dialogue can finish long before the job does.
  const landed = jobs.find((item) => item.conversationIds.includes(id))?.job.evaluation_ids.length ?? 0;
  const reloadConversation = conversation.reload;
  useEffect(() => {
    if (landed) reloadConversation();
  }, [landed, reloadConversation]);
  const runId = chosenRun ?? conversation.data?.latest_evaluation_id ?? null;
  const loaded = useAsync(() => (runId ? api.getEvaluation(runId) : Promise.resolve(null)), [runId, revision]);
  const appeals = useAsync(() => (runId ? api.listAppeals({ evaluation_id: runId }) : Promise.resolve([])), [runId, revision]);
  const run = loaded.data?.id === runId ? loaded.data : null;
  const fallbackSheet = useAsync(
    () => (conversation.data && !run?.checklist ? sheetForChannel(conversation.data.channel) : Promise.resolve(null)),
    [conversation.data?.channel, run?.checklist ? run.id : null],
  );

  // From the start of a run until its result is here the screen stays in "evaluating".
  const [awaiting, setAwaiting] = useState(false);
  const [reveal, setReveal] = useState(false);
  const startedFrom = useRef<string | null>(null);
  const lastProgress = useRef(progress);
  if (progress) lastProgress.current = progress;

  useEffect(() => {
    if (!running) return;
    setAwaiting((current) => {
      if (!current) startedFrom.current = runId;
      return true;
    });
    setChosenRun(null);
    setOpenId(null);
    setReveal(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  useEffect(() => {
    if (running || !awaiting) return;
    if (run && run.id !== startedFrom.current) {
      setAwaiting(false);
      setReveal(true);
      return;
    }
    // A job that died without a run: fall back to what there is.
    const timer = setTimeout(() => setAwaiting(false), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [running, awaiting, run]);

  useEffect(() => {
    if (!reveal) return;
    const timer = setTimeout(() => setReveal(false), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [reveal]);

  const toggle = useCallback((criterionId: string) => {
    setTurnJump(null);
    setOpenId((current) => (current === criterionId ? null : criterionId));
  }, []);

  const criteriaIds = useMemo(() => {
    const checklist = run?.checklist;
    if (!checklist) return [];
    return checklist.sections.flatMap((section) =>
      checklist.criteria.filter((item) => item.section === section.id).map((item) => item.id),
    );
  }, [run]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [role="dialog"]')) return;
      if (event.key === 'Escape') {
        setOpenId(null);
        return;
      }
      if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || !criteriaIds.length) return;
      event.preventDefault();
      setTurnJump(null);
      setOpenId((current) => {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const position = current ? criteriaIds.indexOf(current) : step > 0 ? -1 : criteriaIds.length;
        const next = criteriaIds[Math.min(Math.max(position + step, 0), criteriaIds.length - 1)];
        document.querySelector<HTMLElement>(`[data-crit-row="${next}"]`)?.focus({ preventScroll: true });
        return next;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [criteriaIds]);

  const criteriaScroller = useRef<HTMLDivElement>(null);
  const turnScroller = useRef<HTMLDivElement>(null);
  const columns = useRef<HTMLDivElement>(null);

  // Once the row has unfolded, bring it to the top so its explanation is not below the edge.
  useEffect(() => {
    const box = criteriaScroller.current;
    if (!openId || !run || !box) return;
    const timer = setTimeout(() => {
      const row = box.querySelector(`[data-crit-row="${openId}"]`);
      if (!row) return;
      const top = box.scrollTop + row.getBoundingClientRect().top - box.getBoundingClientRect().top - ROW_TOP_GAP;
      box.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' });
    }, UNFOLD_MS);
    return () => clearTimeout(timer);
  }, [openId, run]);

  const busy = running || awaiting;
  const shownRun = busy ? null : run;
  const focus = useMemo(
    () => focusFor(shownRun, openId, turnJump?.nonce ?? 0, turnJump?.turn ?? null),
    [shownRun, openId, turnJump],
  );

  const evaluate = async () => {
    setStarting(true);
    setStartError(null);
    try {
      track(await api.createEvaluation({ conversation_ids: [id] }), [id]);
    } catch (reason) {
      setStartError(errorText(reason, 'Не удалось запустить оценку'));
    } finally {
      setStarting(false);
    }
  };

  if (conversation.error) return <Panel><ErrorState message={conversation.error} onRetry={conversation.reload} /></Panel>;
  if (!conversation.data) return <Panel><LoadingState label="Загружаем диалог…" /></Panel>;
  const detail = conversation.data;
  const isCall = detail.channel === 'voice call';
  const runs: EvaluationSummary[] = history.data ?? [];
  const checklist = shownRun?.checklist ?? (busy ? (run?.checklist ?? fallbackSheet.data) : null);
  const reasons = shownRun ? visibleFlags(shownRun.review_reasons) : [];
  const hasResults = Boolean(shownRun?.final_results.length && shownRun.checklist);
  const openResult = shownRun?.final_results.find((item) => item.criterion_id === openId);

  const openAudio = () => {
    const url = api.audioUrl(detail.id);
    if (url) host.openExternal(url);
    else setAudioNotice('Записи нет: это синтетические данные.');
  };

  return (
    <>
      <Panel className="rhead">
        <div className="rhead__main">
          <div className="rhead__line">
            <h1 className="title">Диалог {detail.id}</h1>
            <div className="rhead__actions">
              {!busy && <RerunMenu conversationId={detail.id} channel={detail.channel} label={runId ? 'Оценить заново' : 'Оценить'} />}
              {runs.length > 1 && (
                <button type="button" className="icon-action" aria-label="История оценок" title="История оценок" onClick={() => setShowHistory(true)}>
                  <History size={18} strokeWidth={1.75} />
                </button>
              )}
              {detail.has_audio && (
                <button type="button" className="icon-action" aria-label="Открыть запись" title="Открыть запись" onClick={openAudio}>
                  <Headphones size={18} strokeWidth={1.75} />
                </button>
              )}
            </div>
            <span className="rhead__meta">
              <ChannelMark channel={detail.channel} language={languageLabel(detail.language)} />
              {shownRun && isStubRun(shownRun) && <Tag tone="amber">{MOCK_LABEL}</Tag>}
              {audioNotice && <span role="status" className="notice">{audioNotice}</span>}
            </span>
          </div>
          <StageRail run={run} progress={progress ?? (awaiting ? lastProgress.current : null)} onOpenLog={() => setShowLog(true)} />
        </div>
        <div className="rhead__score">
          <ScoreBlock run={run} running={busy} reveal={reveal} />
          {shownRun?.status === 'done' && shownRun.checklist && (
            <HumanReviewMenu
              run={shownRun}
              checklist={shownRun.checklist}
              appeals={(appeals.data ?? []).filter((item) => item.evaluation_id === runId)}
              onPick={(criterionId) => {
                setTurnJump(null);
                setOpenId(criterionId);
                setReviewRequest((current) => ({ id: criterionId, nonce: (current?.nonce ?? 0) + 1 }));
              }}
            />
          )}
        </div>
      </Panel>

      <div ref={columns} className="review-cols">
        <Panel className="scroll-panel">
          <div className="panel-label">{isCall ? 'Расшифровка' : 'Переписка'}</div>
          <div ref={turnScroller} data-scroller className="scroll-panel__body">
            <TurnList turns={detail.turns} isCall={isCall} focus={focus} scroller={turnScroller} />
          </div>
        </Panel>
        <Panel className="scroll-panel">
          <div className="panel-label">Оценка по критериям</div>
          {hasResults && shownRun?.checklist && (
            <ScoreBreakdown run={shownRun} checklist={shownRun.checklist} openId={openId} onToggle={toggle} />
          )}
          <div ref={criteriaScroller} data-scroller className="scroll-panel__body">
            <div className="criteria">
              {loaded.error ? (
                <ErrorState message={loaded.error} onRetry={loaded.reload} />
              ) : busy && !checklist ? (
                <LoadingState label="Оцениваем…" />
              ) : busy || hasResults ? (
                <>
                  {reasons.length > 0 && <p className="why__flag mb-2">Есть спорные места: {reasons.join('; ')}</p>}
                  {appeals.error && <p role="alert" className="notice mb-2" data-tone="bad">Апелляции не загрузились: {appeals.error}</p>}
                  {checklist && (
                    <CriteriaList
                      checklist={checklist}
                      run={shownRun}
                      turns={detail.turns}
                      appeals={(appeals.data ?? []).filter((item) => item.evaluation_id === runId)}
                      openId={openId}
                      reviewRequest={reviewRequest}
                      reveal={reveal}
                      onToggle={toggle}
                      onTurn={(turn) => setTurnJump((current) => ({ turn, nonce: (current?.nonce ?? 0) + 1 }))}
                      onAppealChanged={() => {
                        loaded.reload();
                        appeals.reload();
                      }}
                    />
                  )}
                </>
              ) : runId && !run ? (
                <LoadingState label="Загружаем оценку…" />
              ) : (
                <NoResult detail={detail} run={shownRun} retry={evaluate} busy={starting} failure={startError} />
              )}
            </div>
          </div>
        </Panel>
        <EvidenceLink root={columns} criterionId={openId} turnIndex={openResult?.evidence[0]?.turn_index ?? null} />
      </div>

      {showLog && run && <RunLogPanel run={run} onClose={() => setShowLog(false)} />}
      {showHistory && (
        <CompareDialog
          runs={runs}
          shownId={runId}
          onOpen={(next) => {
            setChosenRun(next);
            setOpenId(null);
            setShowHistory(false);
          }}
          onClose={() => setShowHistory(false)}
        />
      )}
    </>
  );
}
