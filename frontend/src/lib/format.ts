import type { Answer, ChecklistVersion, Criterion, EvaluationRun, EvaluationSummary, ResultStatus } from '../api/types';

export const fmtNumber = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });

export const fmtDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

// Chats carry MM:SS, calls carry ISO in UTC. The raw value stays in the title attribute.
export const fmtTimestamp = (value: string) => {
  const match = value.match(/T(\d{2}:\d{2}:\d{2})/);
  return match ? match[1] : value;
};

export const speakerLabel = (speaker: string) =>
  ({ operator: 'Оператор', client: 'Клиент', bot: 'Бот', system: 'Система' })[speaker] ?? speaker;

export const channelLabel = (channel: string) =>
  ({ 'agent chat': 'Чат', 'voice call': 'Звонок' })[channel] ?? channel;

export const statusLabel = (status: ResultStatus) =>
  ({ assessed: 'Оценено', not_applicable: 'N/A', unassessable: 'Нельзя оценить', failed: 'Сбой оценки' })[status];

export function answerLabel(criterion: Criterion | undefined, status: ResultStatus, answer: Answer): string {
  if (status !== 'assessed') return statusLabel(status);
  if (answer === 'yes') return criterion?.flag ? 'Да, нарушение' : 'Да';
  if (answer === 'no') return criterion?.flag ? 'Нет нарушения' : 'Нет';
  if (typeof answer === 'number' && criterion) {
    return `${answer} из ${Math.max(...criterion.levels.map((level) => level.value))}`;
  }
  return String(answer ?? '—');
}

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'muted';

export function answerTone(criterion: Criterion | undefined, status: ResultStatus, answer: Answer): Tone {
  if (status === 'not_applicable') return 'muted';
  if (status !== 'assessed') return 'warn';
  if (criterion?.flag) return answer === 'yes' ? 'bad' : 'good';
  if (answer === 'yes') return 'good';
  if (answer === 'no') return 'bad';
  if (typeof answer === 'number' && criterion) {
    const top = Math.max(...criterion.levels.map((level) => level.value));
    return answer === top ? 'good' : answer === 0 ? 'bad' : 'warn';
  }
  return 'neutral';
}

const reasonLabels: Record<string, string> = {
  mock_provider: 'Провайдер-заглушка: реальная модель не вызывалась',
  borderline_scale: 'Граница ступеней шкалы',
  channel_not_in_checklist: 'Чек-лист не рассчитан на канал этого диалога',
};
export const reasonLabel = (reason: string) => reasonLabels[reason] ?? reason;

export const STUB_FLAG = 'mock_provider';

// These have their own place on the card: a stub banner, a failure banner, a decision block.
const SEPARATELY_SHOWN = new Set([STUB_FLAG, 'evaluation_failed', 'manual_decision']);
export const reviewNotes = (items: string[]) => items.filter((item) => !SEPARATELY_SHOWN.has(item));

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
  checklist?.criteria.find((criterion) => criterion.id === id)?.title ?? id;

/** Answer without its criterion, for the run comparison where only raw values are known. */
export function plainAnswer(status: ResultStatus, answer: Answer): string {
  if (status !== 'assessed') return statusLabel(status);
  return answer === 'yes' ? 'Да' : answer === 'no' ? 'Нет' : String(answer ?? '—');
}

export const runLabel = (run: EvaluationSummary) =>
  [
    run.status === 'failed' ? 'Сбой' : `Итог ${fmtNumber(run.final_total)}`,
    run.checklist_id ? `v${run.checklist_version}` : 'без чек-листа',
    fmtDate(run.created_at),
    run.checklist_id,
  ]
    .filter(Boolean)
    .join(', ');
