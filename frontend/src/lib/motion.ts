import { useEffect, useRef, useState } from 'react';

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/**
 * Follows a number with a short count. Only a change counts: the value a screen
 * opens with is shown as is, and null to a number jumps unless `fromZero` is set.
 */
export function useCountUp(target: number | null, { delay = 0, fromZero = false, duration = 600 } = {}): number | null {
  const [shown, setShown] = useState(target);
  const previous = useRef(target);

  useEffect(() => {
    const from = previous.current ?? (fromZero ? 0 : null);
    previous.current = target;
    if (target === null || from === null || from === target || reducedMotion()) {
      setShown(target);
      return;
    }
    let frame = 0;
    let started = 0;
    const tick = (time: number) => {
      started ||= time;
      const progress = Math.min((time - started) / duration, 1);
      setShown(from + (target - from) * easeOutCubic(progress));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    const timer = setTimeout(() => {
      frame = requestAnimationFrame(tick);
    }, delay);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      setShown(target);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return shown;
}

/** Seconds since a moment on the client clock, updated once a second. */
export function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}
