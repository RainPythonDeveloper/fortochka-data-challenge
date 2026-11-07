import type { Answer, ChecklistVersion, Criterion, EvaluationRun, EvaluationSummary, ResultStatus } from '../api/types';
import { CHANNELS, LANGUAGES, NOT_APPLICABLE } from './labels';

const THIN_SPACE = ' ';
const group = (text: string) => text.replace(/[  ]/g, THIN_SPACE);

export const fmtNumber = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined ? '—' : group(value.toLocaleString('ru-RU', { maximumFractionDigits: digits }));

/** Totals and points: always two digits, a decimal comma. */
export const fmtScore = (value: number | null | undefined) =>
  value === null || value === undefined
    ? '—'
    : group(value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function fmtDuration(ms: number): string {
  if (ms >= 60_000) {
    const seconds = Math.round(ms / 1000);
    const rest = seconds % 60;
    return `${Math.floor(seconds / 60)} мин${rest ? ` ${rest} с` : ''}`;
  }
  if (ms > 0 && ms < 10) return `< ${fmtNumber(0.01)} с`; // would round to a misleading zero
  const seconds = ms / 1000;
  return `${fmtNumber(seconds, seconds < 0.1 ? 2 : 1)} с`;
}

export const fmtClock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** Russian plural: 1 сбой, 2 сбоя, 5 сбоев. */
export function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100;
  const units = count % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  return units >= 2 && units <= 4 ? few : many;
}

/** "10 баллов", "1 балл", "7,5 балла": a fraction always takes the genitive singular. */
export function fmtPoints(value: number): string {
  const word = Number.isInteger(value) ? plural(Math.abs(value), 'балл', 'балла', 'баллов') : 'балла';
  return `${fmtNumber(value)} ${word}`;
}

const time = (date: Date) => date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export const fmtDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : `${date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} в ${time(date)}`;
};

export function fmtRelative(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин`;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === new Date().toDateString()) return `сегодня в ${time(date)}`;
  if (date.toDateString() === yesterday.toDateString()) return `вчера в ${time(date)}`;
  return fmtDate(value);
}

export const channelLabel = (channel: string) => CHANNELS[channel]?.one ?? channel;
export const channelsLabel = (channel: string) => CHANNELS[channel]?.many ?? channel;
export const languageLabel = (language: string) => LANGUAGES[language.toUpperCase()] ?? language;

export const maxLevel = (criterion: Criterion) => Math.max(...criterion.levels.map((level) => level.value));

export type Tone = 'good' | 'bad' | 'warn' | 'scale' | 'muted';

/** Text of a badge. For a flag the polarity is reversed: "yes" means a violation. */
export function answerText(criterion: Criterion | undefined, status: ResultStatus, answer: Answer): string {
  if (status === 'not_applicable') return NOT_APPLICABLE;
  if (status === 'unassessable') return 'Нельзя оценить';
  if (status === 'failed') return 'Сбой';
  if (criterion?.flag) return answer === 'yes' ? 'Выявлено' : 'Не выявлены';
  if (answer === 'yes') return 'Да';
  if (answer === 'no') return 'Нет';
  if (typeof answer === 'number' && criterion?.levels.length) return `${answer} из ${maxLevel(criterion)}`;
  return String(answer ?? '—');
}

export function answerTone(criterion: Criterion | undefined, status: ResultStatus, answer: Answer): Tone {
  if (status === 'not_applicable') return 'muted';
  if (status !== 'assessed') return 'warn';
  if (criterion?.flag) return answer === 'yes' ? 'bad' : 'good';
  if (answer === 'yes') return 'good';
  if (answer === 'no') return 'bad';
  return 'scale';
}

export const answerKindLabel = (criterion: Criterion) => {
  if (criterion.flag || !criterion.scored) return 'отметка, без баллов';
  if (criterion.type === 'scale') {
    const values = criterion.levels.map((level) => level.value);
    return values.length ? `шкала ${Math.min(...values)}–${Math.max(...values)}` : 'шкала';
  }
  return criterion.allow_na ? 'Да / Нет / не применимо' : 'Да / Нет';
};

const FLAG_TEXT: Record<string, string> = {
  borderline_scale: 'Граница ступеней шкалы',
  ambiguous_rule: 'Спорное правило',
  channel_not_in_checklist: 'Оценочный лист не рассчитан на канал этого диалога',
  partial_result: 'Оценены не все критерии',
  low_confidence: 'Низкая уверенность: проверьте вручную',
  arbitrated: 'Судьи разошлись, решил арбитр',
  judges_disagree: 'Судьи разошлись, арбитр недоступен',
  evidence_rejected: 'Часть цитат не найдена в реплике и отброшена',
  code_hint_conflict: 'Код нашёл реплику о личных контактах или оплате, а модель нарушения не увидела: проверьте',
};

/** "level:15" → "Ступень 15"; the model names which part of the rubric decided. */
export function ruleText(rule: string | null | undefined): string | null {
  if (!rule) return null;
  if (rule === 'yes_when') return 'Условие «Да»';
  if (rule === 'na_when') return 'Условие N/A';
  if (rule === 'prompt') return 'Формулировка критерия';
  const level = /^level:(\d+)$/.exec(rule);
  if (level) return `Ступень шкалы ${level[1]}`;
  const note = /^note:(\d+)$/.exec(rule);
  if (note) return `Уточнение команды № ${note[1]}`;
  return rule;
}

/** Snake_case tokens are technical unless the dictionary names them; plain phrases are shown. */
export function flagText(flag: string): string | null {
  const reason = flag.replace(/^[a-z0-9_-]+:/, ''); // run-level reasons carry the criterion id
  return FLAG_TEXT[reason] ?? (/^[a-z0-9_]+$/.test(reason) ? null : reason);
}

export const visibleFlags = (flags: string[]) => [
  ...new Set(flags.map(flagText).filter((text): text is string => Boolean(text))),
];

export const speakerLabel = (speaker: string) =>
  ({ operator: 'Оператор', client: 'Клиент', bot: 'Бот', system: 'Система' })[speaker] ?? speaker;

export const STUB_FLAG = 'mock_provider';
export const PERSONAL_DATA_FLAG = 'personal_data_not_sent';

/** The backend mixes warnings into ImportResult.errors with a `warning:` prefix. */
export function splitImportMessages(items: string[]): { warnings: string[]; errors: string[] } {
  const prefix = 'warning:';
  return {
    warnings: items.filter((item) => item.startsWith(prefix)).map((item) => item.slice(prefix.length).trim()),
    errors: items.filter((item) => !item.startsWith(prefix)),
  };
}

export const isStubRun = (run: EvaluationRun) =>
  run.review_reasons.includes(STUB_FLAG) ||
  run.results.some((result) => result.review_flags.includes(STUB_FLAG)) ||
  run.log.attempts.some((attempt) => attempt.provider === 'mock');

export const criterionTitle = (checklist: ChecklistVersion | null, id: string) =>
  checklist?.criteria.find((criterion) => criterion.id === id)?.title ?? 'Критерий';

/** Answer without its criterion, for the comparison where only raw values are known. */
export function plainAnswer(status: ResultStatus, answer: Answer): string {
  if (status === 'not_applicable') return NOT_APPLICABLE;
  if (status === 'unassessable') return 'Нельзя оценить';
  if (status === 'failed') return 'Сбой';
  return answer === 'yes' ? 'Да' : answer === 'no' ? 'Нет' : String(answer ?? '—');
}

export const runLabel = (run: EvaluationSummary) =>
  [
    run.status === 'failed' ? 'Сбой' : `Итог ${fmtScore(run.final_total)}`,
    run.checklist_id ? `версия ${run.checklist_version}` : 'без оценочного листа',
    fmtDate(run.created_at),
  ].join(', ');

export const errorText = (reason: unknown, fallback: string) => (reason instanceof Error ? reason.message : fallback);
