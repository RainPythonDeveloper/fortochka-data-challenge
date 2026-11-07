import { useEffect, useRef } from 'react';
import type { Turn } from '../api/types';
import { fmtTimestamp, speakerLabel } from '../lib/format';

/** Everything is addressed by Turn.index: timestamps repeat, array position may not match. */
export type TurnFocus = {
  target: number;
  marked: number[];
  expected: { turn: number; label: string } | null;
  nonce: number;
};

const roleStyles: Record<string, { row: string; label: string; text: string }> = {
  operator: { row: 'border-l-[3px] border-brand-700 bg-white', label: 'font-semibold text-brand-800', text: 'text-stone-900' },
  client: { row: 'border-l-[3px] border-stone-400 bg-white', label: 'font-semibold text-stone-700', text: 'text-stone-900' },
  bot: { row: 'border-l-[3px] border-transparent', label: 'text-stone-400', text: 'text-xs text-stone-500' },
  system: { row: 'border-l-[3px] border-transparent', label: 'text-stone-400', text: 'text-xs italic text-stone-500' },
};

export function TurnRow({ turn, marked, flash }: { turn: Turn; marked?: boolean; flash?: boolean }) {
  const style = roleStyles[turn.speaker] ?? roleStyles.client;
  return (
    <div
      data-turn-index={turn.index}
      data-speaker={turn.speaker}
      className={`rounded-r px-2 py-1 ${style.row} ${marked ? '!bg-amber-100 outline outline-1 outline-amber-400' : ''} ${flash ? 'turn-flash' : ''}`}
    >
      <div className="flex items-baseline gap-2 text-xs">
        <span className={style.label}>{speakerLabel(turn.speaker)}</span>
        <span className="text-stone-400 tabular-nums" title={turn.timestamp}>{fmtTimestamp(turn.timestamp)}</span>
        <span className="ml-auto text-stone-400 tabular-nums">#{turn.index}</span>
      </div>
      <p className={`whitespace-pre-wrap break-words ${style.text}`}>{turn.text}</p>
    </div>
  );
}

export function Transcript({ turns, focus }: { turns: Turn[]; focus: TurnFocus | null }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focus) return;
    container.current
      ?.querySelector(`[data-turn-index="${focus.target}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focus]);

  return (
    <div ref={container} className="space-y-1 p-2">
      {turns.map((turn) => (
        <div key={turn.index}>
          {focus?.expected?.turn === turn.index && (
            <div className="mb-1 rounded border border-dashed border-amber-500 bg-amber-50 px-2 py-0.5 text-xs text-amber-900">
              Здесь ожидалось: {focus.expected.label}
            </div>
          )}
          <TurnRow
            key={focus?.target === turn.index ? focus.nonce : undefined}
            turn={turn}
            marked={focus?.marked.includes(turn.index)}
            flash={focus?.target === turn.index}
          />
        </div>
      ))}
    </div>
  );
}
