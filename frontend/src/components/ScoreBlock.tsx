import type { EvaluationRun } from '../api/types';
import { fmtScore } from '../lib/format';
import { useCountUp } from '../lib/motion';
import { VERDICTS, shownTotal, verdictOf } from '../lib/scoreBands';
import { Swap } from './ui';

const LEGEND = VERDICTS.map((item) => `${item.name}: ${item.hint}`).join('\n');

export function RangeBar({ value }: { value: number | null }) {
  const show = value !== null;
  return (
    <div className="range" data-show={show || undefined} role="img" aria-label={show ? `Итог ${fmtScore(value)} из 100` : 'Итога нет'}>
      <span className="range__band" data-band="low" />
      <span className="range__band" data-band="mid" />
      <span className="range__band" data-band="high" />
      {show && <span className="range__mark" style={{ left: `${Math.min(Math.max(value, 0), 100)}%` }} />}
    </div>
  );
}

function subline(run: EvaluationRun | null, running: boolean): string {
  if (running || !run) return 'из 100';
  if (run.status === 'failed') return 'оценка не выполнена';
  const { total, partial_total: partial, gross_error: gross } = run.final_score;
  if (gross) return `по чек-листу ${fmtScore(total ?? partial)}`;
  if (total === null) return partial !== null ? 'частичный итог' : 'итог не рассчитан';
  const original = run.score.total;
  return original !== total && original !== null ? `исходная ${fmtScore(original)}` : 'из 100';
}

/** `reveal` counts up from zero: the result has just arrived, it was not simply opened. */
export function ScoreBlock({ run, running, reveal }: { run: EvaluationRun | null; running: boolean; reveal: boolean }) {
  const score = run?.status === 'done' && !running ? run.final_score : null;
  const gross = Boolean(score?.gross_error);
  const total = score ? shownTotal(score.total, gross) : null;
  const partial = total === null ? (score?.partial_total ?? null) : null;
  const verdict = score ? verdictOf(score.total, gross) : null;
  const shown = useCountUp(total, { fromZero: reveal, delay: reveal ? 0 : 300 });
  const line = subline(run, running);
  return (
    <div className="score">
      <div className="score__top">
        {verdict && (
          <span className="verdict" data-verdict={verdict.id} data-size="large" title={LEGEND}>
            {verdict.name}
          </span>
        )}
        <div className="score__num" data-dim={total === null || undefined} data-zero={gross || undefined}>
          {total !== null ? fmtScore(shown) : partial !== null ? fmtScore(partial) : '—'}
        </div>
      </div>
      <RangeBar value={total} />
      <div className="score__sub"><Swap id={line} align="end">{line}</Swap></div>
    </div>
  );
}
