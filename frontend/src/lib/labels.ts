// Interface wording, in one place. The dictionary is in design/SAPA_UI_SPEC.md, section 9.
import type { StageId } from '../api/types';

export const STAGES: { id: StageId; name: string }[] = [
  { id: 'parse', name: 'Разбор диалога' },
  { id: 'model', name: 'Оценка моделью' },
  { id: 'validate', name: 'Проверка цитат' },
  { id: 'score', name: 'Расчёт итога' },
];

export const stageName = (id: StageId) => STAGES.find((stage) => stage.id === id)?.name ?? id;

export const NAV = [
  { to: '/conversations', label: 'Диалоги' },
  { to: '/sheet', label: 'Оценочный лист' },
];

export const CHANNELS: Record<string, { one: string; many: string }> = {
  'agent chat': { one: 'Чат', many: 'Чаты' },
  'voice call': { one: 'Звонок', many: 'Звонки' },
};

export const LANGUAGES: Record<string, string> = { RU: 'Русский', KZ: 'Казахский', EN: 'Английский' };

export const MOCK_LABEL = 'Синтетические данные';
export const NOT_APPLICABLE = 'Не применимо';
export const GROSS = 'Грубое нарушение';
export const FROM_CACHE = 'Взято из прошлой оценки';
