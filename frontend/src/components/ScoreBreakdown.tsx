import { ShieldAlert } from 'lucide-react';
import type { ChecklistVersion, EvaluationRun } from '../api/types';
import { fmtScore } from '../lib/format';

const SHOWN_LOSSES = 3;

type Props = { run: EvaluationRun; checklist: ChecklistVersion; openId: string | null; onToggle: (id: string) => void };

/** Why the total is what it is: the violation if there is one, then where points went. */
export function ScoreBreakdown({ run, checklist, openId, onToggle }: Props) {
  const { criteria, gross_error: gross, gross_error_criteria: grossIds } = run.final_score;
  const parts = checklist.criteria.flatMap((criterion) => {
    const score = criteria.find((item) => item.criterion_id === criterion.id);
    return score?.effective_weight ? [{ criterion, score, weight: score.effective_weight }] : [];
  });
  if (!parts.length) return null;
  const losses = parts
    .flatMap(({ criterion, score, weight }) => {
      const lost = score.points === null ? 0 : weight - score.points;
      return lost > 0.005 ? [{ id: criterion.id, title: criterion.title, lost }] : [];
    })
    .sort((a, b) => b.lost - a.lost);
  const lost = losses.reduce((sum, item) => sum + item.lost, 0);
  const excluded = criteria.filter((item) => item.status === 'not_applicable').length;
  const flagged = grossIds[0];

  return (
    <div className="breakdown">
      {gross && (
        <button type="button" className="breakdown__gross" onClick={() => flagged && openId !== flagged && onToggle(flagged)}>
          <ShieldAlert size={16} strokeWidth={1.75} aria-hidden />
          Грубое нарушение: отмечается отдельно, итог не меняет. Открыть основание
        </button>
      )}
      <p className="breakdown__line">
        {losses.length === 0 ? (
          <span>Баллы не потеряны</span>
        ) : (
          <span title={losses.map((item) => `${item.title}: −${fmtScore(item.lost)}`).join('\n')}>
            Потеряно <b>{fmtScore(lost)}</b>:{' '}
            {losses.slice(0, SHOWN_LOSSES).map((item) => `${item.title} −${fmtScore(item.lost)}`).join(', ')}
            {losses.length > SHOWN_LOSSES && ` и ещё ${losses.length - SHOWN_LOSSES}`}
          </span>
        )}
        {excluded > 0 && <span className="breakdown__na">Не применимо: {excluded}</span>}
      </p>
      <div className="breakdown__bar">
        {parts.map(({ criterion, score, weight }) => (
          <button
            key={criterion.id}
            type="button"
            className="breakdown__seg"
            style={{ flexGrow: weight, flexBasis: 0 }}
            data-missing={score.points === null || undefined}
            aria-pressed={openId === criterion.id}
            aria-label={`${criterion.title}: ${fmtScore(score.points)} из ${fmtScore(weight)}`}
            title={`${criterion.title}: ${fmtScore(score.points)} из ${fmtScore(weight)}`}
            onClick={() => onToggle(criterion.id)}
          >
            <span className="breakdown__fill" style={{ transform: `scaleX(${(score.points ?? 0) / weight})` }} />
          </button>
        ))}
      </div>
    </div>
  );
}
