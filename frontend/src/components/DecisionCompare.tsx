import type { Appeal, EvaluationRun } from '../api/types';
import { answerLabel, answerTone, fmtDate, fmtNumber } from '../lib/format';
import { Badge } from './ui';

function Outcome({ run, criterionId, side }: { run: EvaluationRun; criterionId: string; side: 'original' | 'final' }) {
  const criterion = run.checklist?.criteria.find((item) => item.id === criterionId);
  const results = side === 'original' ? run.results : run.final_results;
  const scores = side === 'original' ? run.score : run.final_score;
  const result = results.find((item) => item.criterion_id === criterionId);
  const score = scores.criteria.find((item) => item.criterion_id === criterionId);
  if (!result) return <span>—</span>;
  return (
    <>
      <Badge tone={answerTone(criterion, result.status, result.answer)}>{answerLabel(criterion, result.status, result.answer)}</Badge>
      <p className="mt-0.5 text-xs text-stone-600">Баллы: {fmtNumber(score?.points)}</p>
    </>
  );
}

/** Original score, decision and final result side by side, as required for function 06. */
export function DecisionCompare({ run, appeal }: { run: EvaluationRun; appeal: Appeal }) {
  const decision = appeal.decision;
  if (!decision) return null;
  return (
    <div data-testid="decision-compare" className="grid grid-cols-[1fr_2fr_1fr] gap-px overflow-hidden rounded border border-line bg-line text-[13px]">
      <div className="bg-white p-2">
        <p className="mb-0.5 text-xs font-medium text-stone-500">Исходная оценка</p>
        <Outcome run={run} criterionId={appeal.criterion_id} side="original" />
      </div>
      <div className="bg-white p-2">
        <p className="mb-0.5 text-xs font-medium text-stone-500">
          Решение: {decision.decision === 'change' ? 'оценка изменена' : 'оценка подтверждена'}
        </p>
        <p>{decision.reason}</p>
        <p className="mt-0.5 text-xs text-stone-500">{decision.reviewer}, {fmtDate(decision.decided_at)}</p>
      </div>
      <div className="bg-brand-50 p-2">
        <p className="mb-0.5 text-xs font-medium text-stone-500">Финальный результат</p>
        <Outcome run={run} criterionId={appeal.criterion_id} side="final" />
      </div>
    </div>
  );
}
