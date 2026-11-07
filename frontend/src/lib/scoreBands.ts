// Our own bands: the official checklist has none. The widths of the range bar follow them.
export const SCORE_BANDS = [
  { id: 'low', upTo: 60, name: 'низкий уровень' },
  { id: 'mid', upTo: 80, name: 'средний уровень' },
  { id: 'high', upTo: Infinity, name: 'высокий уровень' },
] as const;

export const bandOf = (total: number) => SCORE_BANDS.find((band) => total < band.upTo) ?? SCORE_BANDS[2];
