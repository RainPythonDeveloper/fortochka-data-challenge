import { UserCheck } from 'lucide-react';
import type { Appeal, ChecklistVersion, EvaluationRun } from '../api/types';
import { AnswerBadge } from './AnswerBadge';
import { needsReview } from './CriteriaList';
import { Button, Menu } from './ui';

type State = 'waiting' | 'doubt' | 'checked' | 'none';

const STATE_TEXT: Record<State, string> = {
  waiting: 'ждёт решения',
  doubt: 'система сомневается',
  checked: 'проверено человеком',
  none: '',
};

const ORDER: Record<State, number> = { waiting: 0, doubt: 1, checked: 2, none: 3 };

type Props = {
  run: EvaluationRun;
  checklist: ChecklistVersion;
  appeals: Appeal[];
  onPick: (criterionId: string) => void;
};

/**
 * Entry point for human review next to the score: lists every criterion with
 * its review state and opens the chosen one with the review form already open.
 */
export function HumanReviewMenu({ run, checklist, appeals, onPick }: Props) {
  const rows = checklist.criteria
    .map((criterion) => {
      const result = run.final_results.find((item) => item.criterion_id === criterion.id);
      const own = appeals.filter((item) => item.criterion_id === criterion.id);
      const state: State = own.some((item) => item.status === 'open')
        ? 'waiting'
        : own.some((item) => item.status === 'decided')
          ? 'checked'
          : needsReview(result)
            ? 'doubt'
            : 'none';
      return { criterion, result, state };
    })
    .sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  const pending = rows.filter((row) => row.state === 'waiting' || row.state === 'doubt').length;
  const checked = rows.filter((row) => row.state === 'checked').length;
  const hint = pending ? `требуют внимания: ${pending}` : checked ? `проверено: ${checked}` : 'по любому критерию';

  return (
    <Menu
      popClass="hr-menu"
      trigger={({ open, toggle }) => (
        <Button
          variant={pending ? 'primary' : 'secondary'}
          aria-expanded={open}
          onClick={toggle}
          className="hr-trigger"
          title="Подтвердить или изменить ответ модели по критерию"
        >
          <UserCheck size={16} strokeWidth={1.75} aria-hidden /> Проверка человеком
          <span className="hr-trigger__count">{hint}</span>
        </Button>
      )}
    >
      {(close) => (
        <div className="hr-list">
          <p className="hr-list__intro">
            Проверяющий открывает критерий, смотрит цитаты и правило, затем подтверждает или меняет ответ модели и пишет
            причину. Итог пересчитывается сразу; исходная оценка ИИ сохраняется и идёт в экспорт отдельно.
          </p>
          {rows.map(({ criterion, result, state }) => (
            <button
              key={criterion.id}
              type="button"
              className="menu__item hr-list__row"
              onClick={() => {
                close();
                onPick(criterion.id);
              }}
            >
              <span className="hr-list__title">{criterion.title}</span>
              {result && <AnswerBadge criterion={criterion} status={result.status} answer={result.answer} />}
              {state !== 'none' && (
                <span className="hr-list__state" data-state={state}>
                  {STATE_TEXT[state]}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </Menu>
  );
}
