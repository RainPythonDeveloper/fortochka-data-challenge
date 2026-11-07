import type { EvaluationRun, StageId } from '../api/types';
import { fmtClock, fmtDuration, fmtNumber } from '../lib/format';
import type { Progress } from '../lib/jobs';
import { FROM_CACHE, STAGES } from '../lib/labels';
import { useElapsed } from '../lib/motion';
import { Spinner, Swap } from './ui';

type State = 'wait' | 'run' | 'done' | 'failed';

function Mark({ state }: { state: State }) {
  if (state === 'run') return <Spinner />;
  if (state !== 'done') return <span className="stage__dot" />;
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle cx="7" cy="7" r="7" fill="currentColor" />
      <path d="M4 7.2l2 2 4-4.4" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const modelMs = (run: EvaluationRun) => {
  const timed = run.log.attempts.flatMap((attempt) => (attempt.latency_ms === null ? [] : [attempt.latency_ms]));
  return timed.length ? timed.reduce((sum, value) => sum + value, 0) : null;
};

function stageMs(run: EvaluationRun, id: StageId): number | null {
  const logged = run.log.stages?.find((stage) => stage.id === id)?.ms;
  return logged ?? (id === 'model' ? modelMs(run) : null);
}

function ModelTip({ run }: { run: EvaluationRun }) {
  const { attempts, cache_hit: cached, latency_ms: latency, evaluator } = run.log;
  const tokens = attempts.reduce((sum, item) => sum + (item.input_tokens ?? 0) + (item.output_tokens ?? 0), 0);
  const retries = attempts.filter((item) => item.attempt > 1).length;
  const model = attempts[0]?.model ?? (evaluator?.model as string | undefined);
  return (
    <>
      {model && <div>Модель: {model}</div>}
      {cached ? <div>{FROM_CACHE}</div> : (
        <div>Вызовов: {attempts.length}{tokens > 0 && `, токенов: ${fmtNumber(tokens)}`}, повторов: {retries}</div>
      )}
      {latency !== null && <div>Всего: {fmtDuration(latency)}</div>}
    </>
  );
}

type Props = { run: EvaluationRun | null; progress: Progress | null; onOpenLog: () => void };

export function StageRail({ run, progress, onOpenLog }: Props) {
  const elapsed = useElapsed(progress ? progress.startedAt : null);
  const failed = !progress && run?.status === 'failed';
  const current = progress ? (progress.stage === 'queued' ? null : (progress.stage ?? 'model')) : null;
  const currentIndex = STAGES.findIndex((stage) => stage.id === current);
  // A failed run stops at the first stage it did not log.
  const failedIndex = failed ? STAGES.findIndex((stage) => !run?.log.stages?.some((item) => item.id === stage.id)) : -1;
  const version = run?.checklist ? `Оценочный лист: ${run.checklist.title}, версия ${run.checklist_version}` : null;

  const describe = (id: StageId, index: number): { state: State; time: string } => {
    if (progress) {
      if (index < currentIndex) return { state: 'done', time: '' };
      if (index > currentIndex || currentIndex < 0) return { state: 'wait', time: progress.stage === 'queued' && index === 0 ? 'в очереди' : '' };
      return { state: 'run', time: id === 'model' ? fmtClock(elapsed) : 'идёт' };
    }
    if (!run) return { state: 'wait', time: '' };
    if (failed) {
      const stop = failedIndex < 0 ? 1 : failedIndex;
      if (index < stop) return { state: 'done', time: stageTime(run, id) };
      return index === stop ? { state: 'failed', time: 'сбой' } : { state: 'wait', time: '' };
    }
    return { state: 'done', time: stageTime(run, id) };
  };

  return (
    <ol
      className="stages"
      role="button"
      tabIndex={run ? 0 : -1}
      aria-label="Этапы оценки. Открыть журнал"
      onClick={() => run && onOpenLog()}
      onKeyDown={(event) => {
        if (run && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onOpenLog();
        }
      }}
    >
      {STAGES.map((stage, index) => {
        const { state, time } = describe(stage.id, index);
        return (
          <li key={stage.id} className="stage" data-state={state}>
            <span className="stage__mark"><Swap id={state}><Mark state={state} /></Swap></span>
            <span className="stage__name">{stage.name}</span>
            <span className="stage__time">{time}</span>
            {run && !progress && (stage.id === 'model' || version) && (
              <span className="stage__tip" data-primary={stage.id === 'model' || undefined}>
                {stage.id === 'model' && <ModelTip run={run} />}
                {version && <div>{version}</div>}
                <div>Нажмите, чтобы открыть журнал</div>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function stageTime(run: EvaluationRun, id: StageId): string {
  if (id === 'model' && run.log.cache_hit) return FROM_CACHE;
  const ms = stageMs(run, id);
  return ms === null ? '' : fmtDuration(ms);
}

