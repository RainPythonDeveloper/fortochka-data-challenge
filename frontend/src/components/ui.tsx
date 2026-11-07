import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Tone } from '../lib/format';

const buttonStyles = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 disabled:bg-stone-300',
  secondary: 'border border-line bg-white text-stone-800 hover:bg-stone-50 disabled:text-stone-400',
  ghost: 'text-brand-700 hover:bg-brand-50 disabled:text-stone-400',
  danger: 'border border-red-200 bg-white text-red-700 hover:bg-red-50 disabled:text-stone-400',
};

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof buttonStyles }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex h-7 items-center gap-1 whitespace-nowrap rounded px-2.5 text-[13px] font-medium disabled:cursor-not-allowed ${buttonStyles[variant]} ${className}`}
    />
  );
}

const badgeStyles: Record<Tone, string> = {
  neutral: 'bg-stone-100 text-stone-700',
  good: 'bg-brand-100 text-brand-800',
  warn: 'bg-amber-100 text-amber-900',
  bad: 'bg-red-100 text-red-800',
  muted: 'bg-stone-200 text-stone-600',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-block whitespace-nowrap rounded px-1.5 py-px text-xs font-medium ${badgeStyles[tone]}`}>{children}</span>;
}

export function LoadingState({ label = 'Загрузка…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 p-8 text-stone-500">
      <span className="size-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-700" />
      {label}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="m-4 rounded border border-red-200 bg-red-50 p-3 text-red-800">
      <p className="font-medium">Не удалось загрузить данные</p>
      <p className="mt-0.5">{message}</p>
      {onRetry && (
        <Button className="mt-2" onClick={onRetry}>
          Повторить
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="p-8 text-center text-stone-500">
      <p className="font-medium text-stone-700">{title}</p>
      {children && <div className="mt-1">{children}</div>}
    </div>
  );
}

export function Banner({ tone, title, children }: { tone: 'bad' | 'warn' | 'info'; title: ReactNode; children?: ReactNode }) {
  const styles = {
    bad: 'border-red-700 bg-red-700 text-white',
    warn: 'border-amber-300 bg-amber-50 text-amber-950',
    info: 'border-stone-300 bg-stone-100 text-stone-800',
  };
  return (
    <div className={`rounded border px-3 py-2 ${styles[tone]}`}>
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-0.5">{children}</div>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-xs font-medium text-stone-600">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-xs text-stone-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded border border-line bg-white px-2 py-1 text-[13px] outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg rounded-md bg-white p-4 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}
