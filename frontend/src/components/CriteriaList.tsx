import type { Appeal, ChecklistVersion, Criterion, CriterionScore, EvaluationRun, SectionScore } from '../api/types';
import { fmtNumber, fmtScore, visibleFlags } from '../lib/format';
import { AnswerBadge } from './AnswerBadge';
import { AppealBlock } from './AppealBlock';
import { Collapse } from './ui';

const TurnLink = ({ index, onTurn }: { index: number; onTurn: (turn: number) => void }) => (
  <button type="button" className="turn-link" onClick={() => onTurn(index)}>#{index}</button>
);

function WeightLine({ criterion, score, notApplicable }: { criterion: Criterion; score?: CriterionScore; notApplicable: boolean }) {
  if (criterion.flag || !criterion.scored) return <p className="why__small">Без баллов, на итог не влияет</p>;
  if (notApplicable) return <p className="why__small">Вес {fmtNumber(criterion.weight)} распределён между остальными</p>;
  const effective = score?.effective_weight ?? null;
  const moved = effective !== null && Math.abs(effective - criterion.weight) > 0.005;
  return (
    <p className="why__small">
      Вес {fmtNumber(criterion.weight)}
      {moved && ` → ${fmtScore(effective)} после исключения неприменимых`}
      {score?.points !== null && score?.points !== undefined && ` · баллы ${fmtScore(score.points)}`}
    </p>
  );
}

type DetailsProps = {
  run: EvaluationRun;
  criterion: Criterion;
  appeals: Appeal[];
  onTurn: (turn: number) => void;
  onAppealChanged: () => void;
};

function Details({ run, criterion, appeals, onTurn, onAppealChanged }: DetailsProps) {
  const result = run.final_results.find((item) => item.criterion_id === criterion.id);
  const original = run.results.find((item) => item.criterion_id === criterion.id);
  const score = run.final_score.criteria.find((item) => item.criterion_id === criterion.id);
  if (!result) return null;
  const notApplicable = result.status === 'not_applicable';
  const range = result.reviewed_range;
  const rangeText = range && (
    <>
      {range.from_turn === range.to_turn ? <>проверена <TurnLink index={range.from_turn} onTurn={onTurn} /></> : (
        <>проверены <TurnLink index={range.from_turn} onTurn={onTurn} />–<TurnLink index={range.to_turn} onTurn={onTurn} /></>
      )}
    </>
  );
  const first = result.evidence[0];
  const flags = visibleFlags(result.review_flags);

  return (
    <div className="why">
      <p className="why__text">{result.justification}</p>
      {notApplicable ? (
        <p className="why__small">Условие неприменимости выполнено</p>
      ) : first ? (
        <p className="why__small">
          Основание: {result.evidence.length > 1 ? 'реплики' : 'реплика'}{' '}
          {result.evidence.map((item, position) => (
            <span key={`${item.turn_index}-${position}`}>
              {position > 0 && ', '}
              <TurnLink index={item.turn_index} onTurn={onTurn} />
            </span>
          ))}
          {rangeText && <>, {rangeText}</>}
        </p>
      ) : result.expected_at_turn !== null ? (
        <p className="why__small">
          Действие ожидалось в <TurnLink index={result.expected_at_turn} onTurn={onTurn} />
          {rangeText && <>, {rangeText}</>}
        </p>
      ) : (
        rangeText && <p className="why__small">Основание: {rangeText}</p>
      )}
      <WeightLine criterion={criterion} score={score} notApplicable={notApplicable} />
      {flags.map((flag) => <p key={flag} className="why__flag">{flag}</p>)}
      <AppealBlock run={run} criterion={criterion} result={result} original={original} appeals={appeals} onChanged={onAppealChanged} />
    </div>
  );
}

function sectionResult(section: SectionScore | undefined, incomplete: boolean): string {
  if (!section || section.percent === null) return 'отметка';
  return `${fmtScore(section.earned)} из ${fmtScore(section.possible)}${incomplete ? ' · неполно' : ''}`;
}

type Props = {
  checklist: ChecklistVersion;
  /** Null while the model is working: rows show placeholders. */
  run: EvaluationRun | null;
  appeals: Appeal[];
  openId: string | null;
  reveal: boolean;
  onToggle: (id: string) => void;
  onTurn: (turn: number) => void;
  onAppealChanged: () => void;
};

export function CriteriaList({ checklist, run, appeals, openId, reveal, onToggle, onTurn, onAppealChanged }: Props) {
  let position = -1;
  const missing = new Set(run?.final_score.missing_criteria ?? []);
  return (
    <>
      {checklist.sections.map((section) => {
        const criteria = checklist.criteria.filter((item) => item.section === section.id);
        if (!criteria.length) return null;
        const score = run?.final_score.sections.find((item) => item.section_id === section.id);
        const incomplete = criteria.some((item) => missing.has(item.id));
        return (
          <div key={section.id}>
            <div className="csection">
              <span>{section.title}</span>
              {run && <span>{sectionResult(score, incomplete)}</span>}
            </div>
            {criteria.map((criterion) => {
              position += 1;
              const open = openId === criterion.id;
              const result = run?.final_results.find((item) => item.criterion_id === criterion.id);
              return (
                <div key={criterion.id} className="crit" data-open={open || undefined}>
                  <button
                    type="button"
                    className="crit__row"
                    data-crit-row={criterion.id}
                    aria-expanded={open}
                    disabled={!run}
                    onClick={() => onToggle(criterion.id)}
                  >
                    <span className="crit__title" title={criterion.title}>{criterion.title}</span>
                    {result ? (
                      <span className={reveal ? 'reveal' : undefined} style={{ '--i': position } as React.CSSProperties}>
                        <AnswerBadge criterion={criterion} status={result.status} answer={result.answer} />
                      </span>
                    ) : (
                      !run && <span className="skeleton" aria-hidden />
                    )}
                  </button>
                  {run && (
                    <Collapse open={open}>
                      <Details
                        run={run}
                        criterion={criterion}
                        appeals={appeals.filter((item) => item.criterion_id === criterion.id)}
                        onTurn={onTurn}
                        onAppealChanged={onAppealChanged}
                      />
                    </Collapse>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
