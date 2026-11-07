import { useState } from 'react';
import { api } from '../api';
import type { Answer, Appeal, Criterion, CriterionResult, DecisionCreate, EvaluationRun } from '../api/types';
import { host } from '../host/hostAdapter';
import { answerText, errorText } from '../lib/format';
import { NOT_APPLICABLE } from '../lib/labels';
import { Button, Menu, Swap } from './ui';

const REVIEWER_KEY = 'sapa.reviewer';

function storedReviewer(): string {
  try {
    return localStorage.getItem(REVIEWER_KEY) ?? host.currentUserName() ?? '';
  } catch {
    return host.currentUserName() ?? '';
  }
}

function rememberReviewer(name: string) {
  try {
    localStorage.setItem(REVIEWER_KEY, name);
  } catch {
    // The field is just empty next time.
  }
}

type Choice = { label: string; decision: Pick<DecisionCreate, 'decision' | 'new_answer' | 'new_status'> };

/** Every answer the rubric allows, other than the one on screen. */
function changeChoices(criterion: Criterion, result: CriterionResult): Choice[] {
  const answers: Answer[] = criterion.type === 'scale' ? criterion.levels.map((level) => level.value) : ['yes', 'no'];
  const choices: Choice[] = answers
    .filter((answer) => result.status !== 'assessed' || answer !== result.answer)
    .map((answer) => ({
      label: answerText(criterion, 'assessed', answer),
      decision: { decision: 'change', new_answer: answer, new_status: 'assessed' },
    }));
  if (criterion.allow_na && result.status !== 'not_applicable') {
    choices.push({ label: NOT_APPLICABLE, decision: { decision: 'change', new_answer: null, new_status: 'not_applicable' } });
  }
  return choices;
}

function SubmitAppeal({ run, criterion, onSaved }: { run: EvaluationRun; criterion: Criterion; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return <div><Button variant="text" onClick={() => setOpen(true)}>Оспорить оценку</Button></div>;
  }
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createAppeal({ evaluation_id: run.id, criterion_id: criterion.id, comment: comment.trim() });
      onSaved();
    } catch (reason) {
      setError(errorText(reason, 'Апелляция не сохранена'));
      setBusy(false);
    }
  };
  return (
    <>
      <label className="tfield !mb-0">
        <span className="tfield__label">Почему оценка неверна</span>
        <textarea autoFocus rows={3} className="field" value={comment} onChange={(event) => setComment(event.target.value)} />
      </label>
      {error && <p role="alert" className="notice" data-tone="bad">{error}</p>}
      <div className="appeal__actions">
        <Button disabled={busy || !comment.trim()} onClick={send}>Отправить апелляцию</Button>
        <Button variant="text" onClick={() => setOpen(false)}>Отмена</Button>
      </div>
    </>
  );
}

type DecideProps = { appeal: Appeal; criterion: Criterion; result: CriterionResult; onSaved: () => void };

function Decide({ appeal, criterion, result, onSaved }: DecideProps) {
  const [picked, setPicked] = useState<Choice | null>(null);
  const [reason, setReason] = useState('');
  const [reviewer, setReviewer] = useState(storedReviewer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = answerText(criterion, result.status, result.answer);
  const confirm: Choice = { label: `Подтвердить «${current}»`, decision: { decision: 'confirm' } };
  const choices = changeChoices(criterion, result);
  const single = criterion.type === 'boolean' ? choices.find((item) => item.decision.new_status === 'assessed') : undefined;
  const rest = choices.filter((item) => item !== single);

  const save = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      rememberReviewer(reviewer.trim());
      await api.decideAppeal(appeal.id, { ...picked.decision, reason: reason.trim(), reviewer: reviewer.trim() });
      onSaved();
    } catch (failure) {
      setError(errorText(failure, 'Решение не сохранено'));
      setBusy(false);
    }
  };

  if (!picked) {
    return (
      <div className="appeal__actions">
        <Button size="large" onClick={() => setPicked(confirm)}>{confirm.label}</Button>
        {single && (
          <Button variant="primary" size="large" onClick={() => setPicked({ ...single, label: `Изменить на «${single.label}»` })}>
            Изменить на «{single.label}»
          </Button>
        )}
        {!single && rest.length > 0 && (
          <Menu
            trigger={({ open, toggle }) => (
              <Button variant="primary" size="large" aria-expanded={open} onClick={toggle}>Изменить оценку</Button>
            )}
          >
            {(close) =>
              rest.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="menu__item"
                  onClick={() => {
                    close();
                    setPicked({ ...item, label: `Изменить на «${item.label}»` });
                  }}
                >
                  {item.label}
                </button>
              ))
            }
          </Menu>
        )}
        {single && rest.map((item) => (
          <Button key={item.label} variant="text" onClick={() => setPicked({ ...item, label: `Изменить на «${item.label}»` })}>
            {item.label}
          </Button>
        ))}
      </div>
    );
  }
  return (
    <>
      <label className="tfield !mb-0">
        <span className="tfield__label">Причина решения</span>
        <textarea autoFocus rows={2} className="field" value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <label className="tfield !mb-0">
        <span className="tfield__label">Проверяющий</span>
        <input className="field" value={reviewer} onChange={(event) => setReviewer(event.target.value)} />
      </label>
      {error && <p role="alert" className="notice" data-tone="bad">{error}</p>}
      <div className="appeal__actions">
        <Button variant="primary" disabled={busy || !reason.trim() || !reviewer.trim()} onClick={save}>{picked.label}</Button>
        <Button variant="text" onClick={() => setPicked(null)}>Отмена</Button>
      </div>
    </>
  );
}

type Props = {
  run: EvaluationRun;
  criterion: Criterion;
  result: CriterionResult;
  original: CriterionResult | undefined;
  appeals: Appeal[];
  onChanged: () => void;
};

/** Filing and deciding are two actions in one place: there are no accounts to separate them. */
export function AppealBlock({ run, criterion, result, original, appeals, onChanged }: Props) {
  const open = appeals.find((item) => item.status === 'open');
  const decided = [...appeals].reverse().find((item) => item.status === 'decided');
  if (run.status !== 'done') return null;
  const state = open ? `open:${open.id}` : decided ? `decided:${decided.id}` : 'none';
  const before = original && answerText(criterion, original.status, original.answer);

  return (
    <div className="appeal">
      <Swap id={state}>
        <div className="appeal">
          {open ? (
            <>
              <p className="appeal__comment">Апелляция: «{open.comment}»</p>
              <Decide appeal={open} criterion={criterion} result={result} onSaved={onChanged} />
            </>
          ) : decided?.decision ? (
            <>
              <p className="appeal__decided">
                {decided.decision.decision === 'change' ? `Изменено проверяющим. Модель ответила «${before}».` : 'Оценка модели подтверждена.'}
              </p>
              <p className="why__small">Причина: {decided.decision.reason} · {decided.decision.reviewer}</p>
            </>
          ) : (
            <SubmitAppeal run={run} criterion={criterion} onSaved={onChanged} />
          )}
        </div>
      </Swap>
    </div>
  );
}
