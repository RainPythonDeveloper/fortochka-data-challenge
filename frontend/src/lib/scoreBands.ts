// Our own bands: the official checklist has none. The widths of the range bar follow them.
export const SCORE_BANDS = [
  { id: 'low', upTo: 60, name: 'Низкий' },
  { id: 'mid', upTo: 80, name: 'Средний' },
  { id: 'high', upTo: Infinity, name: 'Высокий' },
] as const;

export const bandOf = (total: number) => SCORE_BANDS.find((band) => total < band.upTo) ?? SCORE_BANDS[2];

export const VERDICTS = [
  { id: 'critical', name: 'Критично', hint: 'есть грубое нарушение' },
  { id: 'low', name: 'Низкий', hint: 'итог меньше 60' },
  { id: 'mid', name: 'Средний', hint: 'итог от 60 до 80' },
  { id: 'high', name: 'Высокий', hint: 'итог от 80' },
] as const;

export type VerdictId = (typeof VERDICTS)[number]['id'];

/**
 * The total on screen is the checklist total. A gross violation does not change
 * it: the checklist marks it separately, so the screen shows a red badge instead.
 * The verdict «Критично» only classifies the dialogue for lists and filters.
 */
export function verdictOf(total: number | null, gross: boolean) {
  if (gross) return VERDICTS[0];
  if (total === null) return null;
  return VERDICTS.find((verdict) => verdict.id === bandOf(total).id) ?? VERDICTS[3];
}
