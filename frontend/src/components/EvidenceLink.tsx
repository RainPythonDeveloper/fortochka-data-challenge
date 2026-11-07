import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { reducedMotion } from '../lib/motion';

type Points = { x1: number; y1: number; x2: number; y2: number };

const DRAW_DELAY = 600;
const FOLLOW_MS = 1100;

/** The part of an element's scrolling panel it can be seen in. */
function isVisible(element: Element) {
  const scroller = element.closest('[data-scroller]');
  if (!scroller) return false;
  const rect = element.getBoundingClientRect();
  const area = scroller.getBoundingClientRect();
  const middle = rect.top + rect.height / 2;
  return middle >= area.top && middle <= area.bottom;
}

type Props = { root: RefObject<HTMLDivElement | null>; criterionId: string | null; turnIndex: number | null };

/** A green line from the open criterion to the turn it was judged on. */
export function EvidenceLink({ root, criterionId, turnIndex }: Props) {
  const [points, setPoints] = useState<Points | null>(null);
  const [drawn, setDrawn] = useState(false);
  const measure = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    measure.current = () => {
      const box = root.current;
      if (!box || criterionId === null || turnIndex === null) return setPoints(null);
      const row = box.querySelector(`[data-crit-row="${criterionId}"]`);
      const bubble = box.querySelector(`[data-turn-bubble="${turnIndex}"]`);
      if (!row || !bubble || !isVisible(row) || !isVisible(bubble)) return setPoints(null);
      const origin = box.getBoundingClientRect();
      const a = row.getBoundingClientRect();
      const b = bubble.getBoundingClientRect();
      setPoints({
        x1: a.left - 4 - origin.left,
        y1: a.top + a.height / 2 - origin.top,
        x2: b.right + 6 - origin.left,
        y2: b.top + b.height / 2 - origin.top,
      });
    };
  }, [root, criterionId, turnIndex]);

  useEffect(() => {
    const box = root.current;
    if (!box || criterionId === null || turnIndex === null) {
      setPoints(null);
      setDrawn(false);
      return;
    }
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => measure.current());
    };
    // The list is unfolding and the conversation is scrolling: follow them for a moment.
    const until = performance.now() + FOLLOW_MS;
    const follow = () => {
      measure.current();
      if (performance.now() < until) frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);

    const panels = [...box.querySelectorAll('[data-scroller]')];
    const observer = new ResizeObserver(schedule);
    for (const panel of panels) {
      panel.addEventListener('scroll', schedule, { passive: true });
      observer.observe(panel);
      if (panel.firstElementChild) observer.observe(panel.firstElementChild);
    }
    window.addEventListener('resize', schedule);
    setDrawn(false);
    const timer = setTimeout(() => setDrawn(true), reducedMotion() ? 0 : DRAW_DELAY);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      for (const panel of panels) panel.removeEventListener('scroll', schedule);
    };
  }, [root, criterionId, turnIndex]);

  if (!points) return null;
  const { x1, y1, x2, y2 } = points;
  const bend = Math.max((x1 - x2) / 2, 12);
  // Drawn from the message outwards: the evidence is what leads to the criterion.
  const path = `M ${x2} ${y2} C ${x2 + bend} ${y2}, ${x1 - bend} ${y1}, ${x1} ${y1}`;
  return (
    <svg className="link-layer" aria-hidden>
      <g className="link-layer__group" data-drawn={drawn || undefined}>
        <path className="link-layer__path" d={path} pathLength={1} />
        <circle className="link-layer__dot" cx={x2} cy={y2} r={3} />
        <circle className="link-layer__dot" data-end cx={x1} cy={y1} r={3} />
      </g>
    </svg>
  );
}
