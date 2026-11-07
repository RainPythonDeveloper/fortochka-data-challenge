import { useEffect, useMemo, useRef, type RefObject } from 'react';
import type { Evidence, Turn, TurnRange } from '../api/types';
import { reducedMotion } from '../lib/motion';

const HOLD_END = ['больше не находится на удержании', 'no longer on hold'];
const HOLD_START = ['находится на удержании', 'is on hold'];
const isTone = (text: string) => /^[\d#*\s]+$/.test(text);
const has = (text: string, patterns: string[]) => patterns.some((pattern) => text.toLowerCase().includes(pattern));

/** Same reading as cqa_ai.annotate: the turns strictly between the hold events are internal. */
function heldTurns(turns: Turn[]): Set<number> {
  const held = new Set<number>();
  let holding = false;
  for (const turn of turns) {
    if (turn.speaker === 'system') {
      if (has(turn.text, HOLD_END)) holding = false;
      else if (has(turn.text, HOLD_START)) holding = true;
    } else if (holding) {
      held.add(turn.index);
    }
  }
  return held;
}

export type TurnFocus = { evidence: Evidence[]; range: TurnRange | null; target: number | null; nonce: number };

/** The validator guarantees a quote is a substring of its turn, so it can be marked in place. */
function Quoted({ text, quotes }: { text: string; quotes: string[] }) {
  const quote = quotes.find((item) => item && text.includes(item));
  if (!quote) return <>{text}</>;
  const start = text.indexOf(quote);
  return (
    <>
      {text.slice(0, start)}
      <mark className="quote">{quote}</mark>
      {text.slice(start + quote.length)}
    </>
  );
}

type Props = {
  turns: Turn[];
  isCall: boolean;
  focus: TurnFocus | null;
  scroller: RefObject<HTMLDivElement | null>;
};

export function TurnList({ turns, isCall, focus, scroller }: Props) {
  const held = useMemo(() => (isCall ? heldTurns(turns) : new Set<number>()), [isCall, turns]);
  const firstOperator = useMemo(() => turns.find((turn) => turn.speaker === 'operator')?.index ?? Infinity, [turns]);
  const list = useRef<HTMLDivElement>(null);
  const target = focus?.target ?? null;

  useEffect(() => {
    const box = scroller.current;
    if (target === null || !box) return;
    const element = list.current?.querySelector(`[data-turn-bubble="${target}"]`);
    if (!element) return;
    const area = box.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    box.scrollTo({
      top: box.scrollTop + rect.top - area.top - (area.height - rect.height) / 2,
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });
  }, [target, focus?.nonce, scroller]);

  return (
    <div ref={list} className="turns">
      {turns.map((turn) => {
        const quotes = focus?.evidence.filter((item) => item.turn_index === turn.index).map((item) => item.quote) ?? [];
        const evidence = quotes.length > 0 || undefined;
        const range = focus?.range;
        const inRange = range && turn.index >= range.from_turn && turn.index <= range.to_turn;
        const tone = isCall && turn.speaker === 'client' && turn.index < firstOperator && isTone(turn.text);
        const aside = held.has(turn.index) || tone;
        return (
          <div key={turn.index} className="turn" data-who={turn.speaker} data-range={inRange || undefined}>
            <span className="turn__n" title={turn.timestamp}>#{turn.index}</span>
            {turn.speaker === 'system' ? (
              <span className="turn__system" data-turn-bubble={turn.index} data-evidence={evidence}><Quoted text={turn.text} quotes={quotes} /></span>
            ) : aside ? (
              <span className="turn__aside" data-turn-bubble={turn.index}>
                <Quoted text={turn.text} quotes={quotes} />
                {held.has(turn.index) && <small>на удержании</small>}
              </span>
            ) : (
              <span className="bubble" data-turn-bubble={turn.index} data-evidence={evidence}><Quoted text={turn.text} quotes={quotes} /></span>
            )}
          </div>
        );
      })}
    </div>
  );
}
