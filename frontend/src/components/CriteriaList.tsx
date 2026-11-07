import { ChevronDown } from 'lucide-react';
import { useState, type CSSProperties, type ReactNode } from 'react';
import type {
  Appeal,
  ChecklistVersion,
  Criterion,
  CriterionResult,
  CriterionScore,
  EvaluationRun,
  SectionScore,
  Turn,
} from '../api/types';
import { fmtNumber, fmtScore, ruleText, speakerLabel, visibleFlags } from '../lib/format';
import { AnswerBadge } from './AnswerBadge';
import { AppealBlock } from './AppealBlock';
import { Collapse } from './ui';

const Chevron = () => <ChevronDown className="chevron" size={16} strokeWidth={1.75} aria-hidden />;

const TurnLink = ({ index, onTurn }: { index: number; onTurn: (turn: number) => void }) => (
  <button type="button" className="turn-link" onClick={() => onTurn(index)}>#{index}</button>
);

const block = (position: number) => ({ '--i': position }) as CSSProperties;

/** Links "#12" to its turn and underlines a «quote» that really is in the evidence. */
function Conclusion({ result, onTurn }: { result: CriterionResult; onTurn: (turn: number) => void }) {
  const parts: ReactNode[] = [];
  const pattern = /#(\d+)|«([^»]+)»/g;
  let last = 0;
  for (const match of result.justification.matchAll(pattern)) {
    parts.push(result.justification.slice(last, match.index));
    last = match.index + match[0].length;
    const quoted = match[2];
    if (match[1]) {
      parts.push(<TurnLink key={match.index} index={Number(match[1])} onTurn={onTurn} />);
    } else {
      const source = result.evidence.find((item) => item.quote.includes(quoted) || quoted.includes(item.quote));
      parts.push(source ? <mark key={match.index} className="quote-inline">«{quoted}»</mark> : match[0]);
    }
  }
  parts.push(result.justification.slice(last));
  return (
    <p className="why__text">
      {parts}
      {result.evidence.map((item, position) => (
        <button
          key={`${item.turn_index}-${position}`}
          type="button"
          className="cite"
          aria-label={`Источник ${position + 1}, реплика ${item.turn_index}`}
          onClick={() => onTurn(item.turn_index)}
        >
          {position + 1}
        </button>
      ))}
    </p>
  );
}

function Sources({ result, turns, onTurn }: { result: CriterionResult; turns: Turn[]; onTurn: (turn: number) => void }) {
  const range = result.reviewed_range;
  const rangeText = range && (
    range.from_turn === range.to_turn ? (
      <>Проверена реплика <TurnLink index={range.from_turn} onTurn={onTurn} /></>
    ) : (
      <>Проверены реплики <TurnLink index={range.from_turn} onTurn={onTurn} />–<TurnLink index={range.to_turn} onTurn={onTurn} /></>
    )
  );
  if (!result.evidence.length && result.expected_at_turn === null && !range) return null;
  return (
    <div>
      <p className="why__label">Основание</p>
      {result.evidence.length > 0 && (
        <div className="sources">
          {result.evidence.map((item, position) => {
            const speaker = turns.find((turn) => turn.index === item.turn_index)?.speaker;
            return (
              <button key={`${item.turn_index}-${position}`} type="button" className="source" onClick={() => onTurn(item.turn_index)}>
                <span className="cite">{position + 1}</span>
                <span className="source__turn">#{item.turn_index}</span>
                <span className="source__quote">{speaker && `${speakerLabel(speaker)}: `}«{item.quote}»</span>
              </button>
            );
          })}
        </div>
      )}
      {result.expected_at_turn !== null && !result.evidence.length && (
        <p className="why__small">Действие ожидалось в <TurnLink index={result.expected_at_turn} onTurn={onTurn} /></p>
      )}
      {rangeText && <p className="why__small mt-1">{rangeText}</p>}
    </div>
  );
}

type ImpactProps = { criterion: Criterion; result: CriterionResult; score?: CriterionScore; official: number | null; notApplicable: boolean };

function Impact({ criterion, result, score, official, notApplicable }: ImpactProps) {
  if (criterion.flag) {
    return result.answer === 'yes' ? (
      <>
        <span className="impact__delta">Итог обнулён</span>
        <p className="why__small">На экране итог равен 0. По чек-листу {fmtScore(official)}, так он уходит в экспорт.</p>
      </>
    ) : (
      <p className="why__small">Нарушений нет, итог не меняется.</p>
    );
  }
  if (!criterion.scored) return <p className="why__small">Без баллов, итог не меняется.</p>;
  if (notApplicable) return <p className="why__small">Не считается: вес {fmtNumber(criterion.weight)} распределён между остальными критериями.</p>;
  const effective = score?.effective_weight ?? null;
  const points = score?.points ?? null;
  if (effective === null || points === null) return <p className="why__small">Баллов нет: критерий не оценён.</p>;
  const moved = Math.abs(effective - criterion.weight) > 0.005;
  const lost = effective - points;
  return (
    <>
      <span className="impact__value">{fmtScore(points)} из {fmtScore(effective)}</span>
      {lost > 0.005 && <span className="impact__delta"> · −{fmtScore(lost)} к итогу</span>}
      <div className="impact__meter"><span style={{ transform: `scaleX(${effective ? points / effective : 0})` }} /></div>
      <p className="why__small">Вес {fmtNumber(criterion.weight)}{moved && ` → ${fmtScore(effective)} после исключения неприменимых`}</p>
    </>
  );
}

function Rule({ criterion, result, version }: { criterion: Criterion; result: CriterionResult; version: number }) {
  const notApplicable = result.status === 'not_applicable';
  return (
    <div>
      <p className="why__label">Правило листа, версия {version}</p>
      {notApplicable ? (
        <p className="why__small">Не применимо, когда: {criterion.na_when}</p>
      ) : criterion.type === 'scale' ? (
        <div className="ladder">
          {criterion.levels.map((level) => (
            <div key={level.value} className="ladder__step" data-on={result.answer === level.value || undefined}>
              <span>{level.value}</span>
              <span>{level.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="why__small">{criterion.flag ? '' : 'Да, когда: '}{criterion.yes_when}</p>
      )}
    </div>
  );
}

function confidenceTone(value: number): string {
  if (value >= 0.85) return 'var(--color-green-text, #1f6b43)';
  if (value >= 0.67) return 'var(--color-amber-text)';
  return 'var(--color-red-text, #b42318)';
}

/** Why the evaluator decided this way: rule, confidence, judges, what blocked a higher level. */
function Trace({ result, criterion }: { result: CriterionResult; criterion: Criterion }) {
  const rule = ruleText(result.rule_ref);
  const confidence = result.confidence;
  const votes = result.votes ?? [];
  if (!rule && confidence == null && !result.alternative && !votes.length && !result.analysis && !result.facts_used?.length) return null;
  return (
    <div className="trace">
      <p className="why__label">Трасса решения</p>
      {confidence != null && (
        <p className="why__small">
          Уверенность:{' '}
          <b style={{ color: confidenceTone(confidence) }}>{Math.round(confidence * 100)}%</b>
          {confidence < 0.67 ? ' · нужен взгляд проверяющего' : ''}
        </p>
      )}
      {rule && (
        <p className="why__small">
          Решило правило: {rule}
          {result.rule_text ? <span className="trace__rule"> — «{result.rule_text}»</span> : null}
        </p>
      )}
      {result.facts_used && result.facts_used.length > 0 && (
        <p className="why__small">Опора на факты кода: {result.facts_used.join(', ')}</p>
      )}
      {result.alternative && criterion.type === 'scale' && (
        <p className="why__small">Почему не выше: {result.alternative}</p>
      )}
      {votes.length > 1 && (
        <ul className="trace__votes">
          {votes.map((vote, index) => (
            <li key={`${vote.model}-${index}`} className="why__small">
              {index === 2 && result.review_flags.includes('arbitrated') ? 'Арбитр' : `Голос ${index + 1}`} ·{' '}
              <span className="trace__model">{vote.model.split('/').pop()}</span>:{' '}
              <AnswerBadge criterion={criterion} status={vote.status} answer={vote.answer} />
            </li>
          ))}
        </ul>
      )}
      {result.analysis && (
        <details className="trace__analysis">
          <summary className="why__small">Рассуждение модели</summary>
          <p className="why__small">{result.analysis}</p>
        </details>
      )}
    </div>
  );
}

type DetailsProps = {
  run: EvaluationRun;
  criterion: Criterion;
  turns: Turn[];
  appeals: Appeal[];
  onTurn: (turn: number) => void;
  onAppealChanged: () => void;
};

function Details({ run, criterion, turns, appeals, onTurn, onAppealChanged }: DetailsProps) {
  const result = run.final_results.find((item) => item.criterion_id === criterion.id);
  const original = run.results.find((item) => item.criterion_id === criterion.id);
  const score = run.final_score.criteria.find((item) => item.criterion_id === criterion.id);
  if (!result) return null;
  const flags = visibleFlags(result.review_flags);
  return (
    <div className="why">
      <div className="why__main">
        <div className="why__block" style={block(0)}>
          <p className="why__label">Вывод</p>
          <Conclusion result={result} onTurn={onTurn} />
        </div>
        <div className="why__block" style={block(1)}>
          <Sources result={result} turns={turns} onTurn={onTurn} />
        </div>
        {flags.map((flag) => <p key={flag} className="why__flag why__block" style={block(2)}>{flag}</p>)}
        <div className="why__block" style={block(2)}>
          <Trace result={result} criterion={criterion} />
        </div>
      </div>
      <div className="why__side">
        <div className="why__block" style={block(1)}>
          <p className="why__label">Влияние на итог</p>
          <Impact
            criterion={criterion}
            result={result}
            score={score}
            official={run.final_score.total ?? run.final_score.partial_total}
            notApplicable={result.status === 'not_applicable'}
          />
        </div>
        <div className="why__block" style={block(2)}>
          <Rule criterion={criterion} result={result} version={run.checklist_version} />
        </div>
      </div>
      <div className="why__appeal why__block" style={block(3)}>
        <AppealBlock run={run} criterion={criterion} result={result} original={original} appeals={appeals} onChanged={onAppealChanged} />
      </div>
    </div>
  );
}

function sectionResult(section: SectionScore | undefined, incomplete: boolean): string {
  if (!section || section.percent === null) return 'отметка';
  return `${fmtScore(section.earned)} из ${fmtScore(section.possible)}${incomplete ? ' · неполно' : ''}`;
}

function Points({ score, criterion, result }: { score?: CriterionScore; criterion: Criterion; result?: CriterionResult }) {
  if (criterion.flag) return <span className="crit__points">{result?.answer === 'yes' ? 'обнуляет итог' : 'без баллов'}</span>;
  if (!criterion.scored) return <span className="crit__points">без баллов</span>;
  if (score?.points === null || score?.points === undefined) return <span className="crit__points" />;
  return <span className="crit__points"><b>{fmtScore(score.points)}</b> из {fmtScore(score.effective_weight)}</span>;
}

type Props = {
  checklist: ChecklistVersion;
  /** Null while the model is working: rows show placeholders. */
  run: EvaluationRun | null;
  turns: Turn[];
  appeals: Appeal[];
  openId: string | null;
  reveal: boolean;
  onToggle: (id: string) => void;
  onTurn: (turn: number) => void;
  onAppealChanged: () => void;
};

export function CriteriaList({ checklist, run, turns, appeals, openId, reveal, onToggle, onTurn, onAppealChanged }: Props) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const missing = new Set(run?.final_score.missing_criteria ?? []);
  let position = -1;

  const toggleSection = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <>
      {checklist.sections.map((section) => {
        const criteria = checklist.criteria.filter((item) => item.section === section.id);
        if (!criteria.length) return null;
        const score = run?.final_score.sections.find((item) => item.section_id === section.id);
        const incomplete = criteria.some((item) => missing.has(item.id));
        // An open criterion keeps its section open: keys and links can land in a folded one.
        const expanded = !folded.has(section.id) || criteria.some((item) => item.id === openId);
        return (
          <div key={section.id}>
            <button type="button" className="csection" aria-expanded={expanded} onClick={() => toggleSection(section.id)}>
              <span>{section.title}</span>
              <span>{run ? sectionResult(score, incomplete) : ''}</span>
              <Chevron />
            </button>
            <Collapse open={expanded}>
              {criteria.map((criterion) => {
                position += 1;
                const open = openId === criterion.id;
                const result = run?.final_results.find((item) => item.criterion_id === criterion.id);
                const points = run?.final_score.criteria.find((item) => item.criterion_id === criterion.id);
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
                      {run ? <Points score={points} criterion={criterion} result={result} /> : <span />}
                      <span className="crit__answer">
                        {result ? (
                          <span className={reveal ? 'reveal' : undefined} style={block(position)}>
                            <AnswerBadge criterion={criterion} status={result.status} answer={result.answer} />
                          </span>
                        ) : (
                          !run && <span className="skeleton" aria-hidden />
                        )}
                      </span>
                      {run ? <Chevron /> : <span />}
                    </button>
                    {run && (
                      <Collapse open={open}>
                        <Details
                          run={run}
                          criterion={criterion}
                          turns={turns}
                          appeals={appeals.filter((item) => item.criterion_id === criterion.id)}
                          onTurn={onTurn}
                          onAppealChanged={onAppealChanged}
                        />
                      </Collapse>
                    )}
                  </div>
                );
              })}
            </Collapse>
          </div>
        );
      })}
    </>
  );
}
