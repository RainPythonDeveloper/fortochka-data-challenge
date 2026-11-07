// TypeScript port of ai/src/cqa_ai/scoring.py, used by the mock layer only.
// With a real backend the UI never calculates a score.
import type {
  ChecklistVersion,
  CriterionResult,
  CriterionScore,
  ScoreSummary,
  SectionScore,
} from '../api/types.ts';

const round = (value: number) => Math.floor(value * 100 + 0.5 + 1e-9) / 100;

function fraction(criterion: ChecklistVersion['criteria'][number], result: CriterionResult): number {
  if (criterion.type === 'boolean') {
    if (result.answer === 'yes') return 1;
    if (result.answer === 'no') return 0;
    throw new Error(`${criterion.id}: expected yes or no`);
  }
  const values = criterion.levels.map((level) => level.value);
  if (typeof result.answer !== 'number' || !values.includes(result.answer)) {
    throw new Error(`${criterion.id}: ${String(result.answer)} is not a scale level`);
  }
  return result.answer / Math.max(...values);
}

export function calculateScore(checklist: ChecklistVersion, results: CriterionResult[]): ScoreSummary {
  const byId = new Map(results.map((result) => [result.criterion_id, result]));
  const fractions = new Map<string, number>();
  const missing: string[] = [];
  const gross: string[] = [];
  let applicable = 0;
  let earned = 0;

  for (const criterion of checklist.criteria) {
    const result = byId.get(criterion.id);
    const status = result?.status ?? 'failed';
    const weight = criterion.scored ? criterion.weight : 0;
    if (status === 'not_applicable') {
      if (!criterion.allow_na) throw new Error(`${criterion.id}: N/A is not allowed`);
      continue;
    }
    if (status !== 'assessed' || !result) {
      if (weight > 0) {
        applicable += weight;
        missing.push(criterion.id);
      }
      continue;
    }
    const value = fraction(criterion, result);
    if (criterion.flag && result.answer === 'yes') gross.push(criterion.id);
    if (weight > 0) {
      fractions.set(criterion.id, value);
      applicable += weight;
      earned += weight * value;
    }
  }

  const effectiveOf = (id: string, weight: number) =>
    (fractions.has(id) || missing.includes(id)) && applicable > 0 ? (weight * 100) / applicable : null;

  const criteria: CriterionScore[] = checklist.criteria.map((criterion) => {
    const result = byId.get(criterion.id);
    const effective = effectiveOf(criterion.id, criterion.scored ? criterion.weight : 0);
    const value = fractions.get(criterion.id);
    return {
      criterion_id: criterion.id,
      status: result?.status ?? 'failed',
      answer: result?.answer ?? null,
      weight: criterion.weight,
      effective_weight: effective === null ? null : round(effective),
      points: effective === null || value === undefined ? null : round(effective * value),
    };
  });

  const sections: SectionScore[] = checklist.sections.map((section) => {
    const members = checklist.criteria.filter((criterion) => criterion.section === section.id);
    let sectionEarned = 0;
    let possible = 0;
    for (const criterion of members) {
      const effective = effectiveOf(criterion.id, criterion.weight);
      if (effective === null) continue;
      possible += effective;
      sectionEarned += effective * (fractions.get(criterion.id) ?? 0);
    }
    return {
      section_id: section.id,
      title: section.title,
      earned: round(sectionEarned),
      possible: round(possible),
      percent: possible > 0 ? round((sectionEarned * 100) / possible) : null,
      flags: members.filter((c) => gross.includes(c.id) && c.flag).map((c) => c.flag as string),
    };
  });

  const ratio = applicable > 0 ? (100 * earned) / applicable : null;
  return {
    total: ratio !== null && missing.length === 0 ? round(ratio) : null,
    partial_total: ratio !== null && missing.length > 0 ? round(ratio) : null,
    is_partial: missing.length > 0,
    missing_criteria: missing,
    gross_error: gross.length > 0,
    gross_error_criteria: gross,
    criteria,
    sections,
  };
}
