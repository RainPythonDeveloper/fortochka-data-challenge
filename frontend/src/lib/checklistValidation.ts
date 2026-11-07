import type { ChecklistVersion, Criterion } from '../api/types';

export type IssueField = 'title' | 'weight' | 'section' | 'type' | 'yes_when' | 'prompt' | 'na_when' | 'levels';

/** `message` stands alone in the sheet head, `hint` sits under the field itself. */
export type ValidationIssue = {
  criterionId: string | null;
  sectionId?: string;
  field?: IssueField;
  message: string;
  hint: string;
};

type FieldIssue = { field: IssueField; hint: string };

// Repeats the validators of Criterion and ChecklistVersion in contracts.py, plus
// the checks a form needs and the model does not enforce.
function checkCriterion(criterion: Criterion, sectionIds: Set<string>): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const add = (field: IssueField, hint: string) => issues.push({ field, hint });
  if (!criterion.title.trim()) add('title', 'Укажите название');
  if (!Number.isFinite(criterion.weight) || criterion.weight < 0) add('weight', 'Вес должен быть числом не меньше 0');
  if (!criterion.scored && criterion.weight !== 0) add('weight', 'У критерия без баллов вес должен быть 0');
  if (!sectionIds.has(criterion.section)) add('section', 'Выберите секцию');
  if (criterion.flag && criterion.type !== 'boolean') add('type', 'Флаг нарушения работает только с ответом Да / Нет');
  if (criterion.allow_na && !criterion.na_when?.trim()) add('na_when', 'Опишите, когда критерий не применим');

  if (criterion.type === 'boolean') {
    if (!criterion.yes_when?.trim()) add('yes_when', 'Опишите, когда ответ «Да»');
    if (criterion.levels.length) add('levels', 'У критерия Да / Нет не может быть ступеней');
    return issues;
  }
  if (!criterion.prompt?.trim()) add('prompt', 'Опишите задачу шкалы');
  const values = criterion.levels.map((level) => level.value);
  if (values.some((value) => !Number.isInteger(value))) add('levels', 'Значение ступени должно быть целым');
  else if (values.length < 2 || new Set(values).size !== values.length) add('levels', 'Нужны минимум две разные ступени');
  else if (Math.max(...values) <= 0) add('levels', 'Верхняя ступень должна быть больше 0');
  if (criterion.levels.some((level) => !level.text.trim())) add('levels', 'У каждой ступени нужно описание');
  return issues;
}

export const hasWeight = (criterion: Criterion) => criterion.scored && Number.isFinite(criterion.weight) && criterion.weight > 0;

export function validateChecklist(checklist: ChecklistVersion): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const general = (hint: string) => issues.push({ criterionId: null, message: hint, hint });

  if (!checklist.title.trim()) general('Укажите название листа');
  if (!checklist.criteria.length) general('Добавьте хотя бы один критерий');
  else if (!checklist.criteria.some(hasWeight)) general('Нужен хотя бы один критерий с весом: без него итог не рассчитается');

  const titles = new Set<string>();
  for (const section of checklist.sections) {
    const title = section.title.trim().toLowerCase();
    if (!title || titles.has(title)) {
      const hint = title ? `Секция «${section.title.trim()}» уже есть` : 'Укажите название секции';
      issues.push({ criterionId: null, sectionId: section.id, message: hint, hint });
    }
    titles.add(title);
  }

  const sectionIds = new Set(checklist.sections.map((section) => section.id));
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const criterion of checklist.criteria) {
    const name = criterion.title.trim() || 'Без названия';
    const found = checkCriterion(criterion, sectionIds);
    const key = criterion.title.trim().toLowerCase();
    if (key && names.has(key)) found.push({ field: 'title', hint: 'Критерий с таким названием уже есть' });
    if (ids.has(criterion.id)) found.push({ field: 'title', hint: 'Идентификатор повторяется' });
    names.add(key);
    ids.add(criterion.id);
    for (const { field, hint } of found) {
      issues.push({ criterionId: criterion.id, field, hint, message: `«${name}»: ${hint[0].toLowerCase()}${hint.slice(1)}` });
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
    sections: checklist.sections.map((section) => ({ ...section, title: section.title.trim() })),
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
