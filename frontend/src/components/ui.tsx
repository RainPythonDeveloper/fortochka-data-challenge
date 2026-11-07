import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Tone } from '../lib/format';
import { reducedMotion } from '../lib/motion';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'text' | 'icon';
  size?: 'large' | 'normal';
};

export function Button({ variant = 'secondary', size = 'normal', className = '', ...props }: ButtonProps) {
  return <button type="button" {...props} data-variant={variant} data-size={size} className={`btn ${className}`} />;
}

export function Panel({ className = '', children, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <section {...props} className={`panel ${className}`}>
      {children}
    </section>
  );
}

export function Tag({ tone, children }: { tone?: 'amber' | 'bad'; children: ReactNode }) {
  return <span className="tag" data-tone={tone}>{children}</span>;
}

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className="badge" data-tone={tone}>{children}</span>;
}

export function Spinner() {
  return <span className="spinner" aria-hidden />;
}

type ToggleProps = { on: boolean; label: string; disabled?: boolean; title?: string; onChange?: (on: boolean) => void };

export function Toggle({ on, label, disabled, title, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      title={title}
      className="toggle"
      onClick={() => onChange?.(!on)}
    />
  );
}

export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className="fold" data-open={open || undefined}>
      <div className="fold__inner" inert={!open}>{children}</div>
    </div>
  );
}

/** Crossfades one cell when `id` changes. The outgoing content stays for its fade. */
export function Swap({ id, align, children }: { id: string; align?: 'end'; children: ReactNode }) {
  const previous = useRef({ id, children });
  const [outgoing, setOutgoing] = useState<{ id: string; children: ReactNode } | null>(null);

  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = { id, children };
    if (last.id !== id && !reducedMotion()) setOutgoing(last);
  });

  useEffect(() => {
    if (!outgoing) return;
    const timer = setTimeout(() => setOutgoing(null), 200);
    return () => clearTimeout(timer);
  }, [outgoing]);

  return (
    <span className="swap" data-align={align}>
      {outgoing && <span key={`out-${outgoing.id}`} className="swap__item" data-state="out" inert>{outgoing.children}</span>}
      <span key={id} className="swap__item" data-state={outgoing ? 'in' : undefined}>{children}</span>
    </span>
  );
}

/** A small popover by its trigger. Closes on Esc and on a click outside. */
export function Menu({
  trigger,
  children,
  popClass = '',
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  popClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div ref={root} className="menu">
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open && <div className={`menu__pop ${popClass}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function LoadingState({ label = 'Загрузка…' }: { label?: string }) {
  return (
    <div role="status" className="state-box">
      <Spinner /> <span className="ml-2">{label}</span>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="state-box">
      <p className="state-box__title">Не удалось загрузить данные</p>
      <p className="mt-1 mb-3">{message}</p>
      {onRetry && <Button onClick={onRetry}>Повторить</Button>}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state-box">
      <p className="state-box__title">{title}</p>
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}

/** Esc closes it. Focus moves in while it is open and returns to where it was. */
function useDialog(onClose: () => void) {
  const body = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close.current();
    const before = document.activeElement as HTMLElement | null;
    body.current?.focus();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      before?.focus?.();
    };
  }, []);
  return body;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const body = useDialog(onClose);
  return (
    <div className="modal" onClick={onClose}>
      <div ref={body} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="modal__body" onClick={(event) => event.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const body = useDialog(onClose);
  return (
    <div className="drawer" onClick={onClose}>
      <div ref={body} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="drawer__body" onClick={(event) => event.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
