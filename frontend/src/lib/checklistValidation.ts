import type { ChecklistVersion, Criterion } from '../api/types';

export type ValidationIssue = { criterionId: string | null; message: string };

// Repeats the validators of Criterion and ChecklistVersion in contracts.py, plus
// non-empty text checks that a form needs and the model does not enforce.
function checkCriterion(criterion: Criterion, sectionIds: Set<string>): string[] {
  const issues: string[] = [];
  if (!criterion.title.trim()) issues.push('нужно название');
  if (!Number.isFinite(criterion.weight) || criterion.weight < 0) issues.push('вес должен быть числом не меньше 0');
  if (!criterion.scored && criterion.weight !== 0) issues.push('у критерия без баллов вес должен быть 0');
  if (criterion.allow_na && !criterion.na_when?.trim()) issues.push('нужно условие «Когда не применимо»');
  if (!sectionIds.has(criterion.section)) issues.push('выберите существующую секцию');

  if (criterion.type === 'boolean' && !criterion.yes_when?.trim()) issues.push('нужно условие «Когда «Да»»');
  if (criterion.type === 'scale' && !criterion.prompt?.trim()) issues.push('нужна задача шкалы');

  if (criterion.type === 'scale') {
    const values = criterion.levels.map((level) => level.value);
    if (values.some((value) => !Number.isInteger(value))) issues.push('значение ступени должно быть целым');
    if (values.length < 2 || new Set(values).size !== values.length) {
      issues.push('шкале нужны минимум две разные ступени');
    } else if (Math.max(...values) <= 0) {
      issues.push('верхняя ступень шкалы должна быть больше 0');
    }
    if (criterion.levels.some((level) => !level.text.trim())) issues.push('у каждой ступени нужно описание');
  } else if (criterion.levels.length) {
    issues.push('у критерия Да / Нет не может быть ступеней');
  }
  return issues;
}

export function validateChecklist(checklist: ChecklistVersion): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!checklist.title.trim()) issues.push({ criterionId: null, message: 'Нужно название листа' });
  if (!checklist.criteria.length) issues.push({ criterionId: null, message: 'Нужен хотя бы один критерий' });

  const sectionIds = new Set(checklist.sections.map((section) => section.id));
  if (checklist.sections.some((section) => !section.title.trim())) {
    issues.push({ criterionId: null, message: 'У каждой секции нужно название' });
  }

  const seen = new Set<string>();
  for (const criterion of checklist.criteria) {
    const name = criterion.title.trim() || 'Новый критерий';
    if (!criterion.id.trim()) issues.push({ criterionId: criterion.id, message: `${name}: нет идентификатора` });
    if (seen.has(criterion.id)) {
      issues.push({ criterionId: criterion.id, message: `${name}: идентификатор повторяется` });
    }
    seen.add(criterion.id);
    for (const message of checkCriterion(criterion, sectionIds)) {
      issues.push({ criterionId: criterion.id, message: `${name}: ${message}` });
    }
  }
  return issues;
}

/** Empty optional text fields go over the wire as null, as in the Python models. */
export function normalizeChecklist(checklist: ChecklistVersion): ChecklistVersion {
  const text = (value: string | null) => (value?.trim() ? value.trim() : null);
  return {
    ...checklist,
    title: checklist.title.trim(),
    criteria: checklist.criteria.map((criterion) => ({
      ...criterion,
      title: criterion.title.trim(),
      yes_when: text(criterion.yes_when),
      prompt: text(criterion.prompt),
      na_when: criterion.allow_na ? text(criterion.na_when) : null,
      levels: criterion.type === 'scale' ? criterion.levels : [],
      team_notes: criterion.team_notes.map((note) => note.trim()).filter(Boolean),
    })),
  };
}
