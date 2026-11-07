import { useEffect, useState } from 'react';
import { api } from '../api';
import { channelLabel } from '../lib/format';
import { useJobs } from '../lib/jobs';
import { useAsync } from '../lib/useAsync';
import { Button, inputClass } from './ui';

type Props = { conversationIds: string[]; channels: string[]; buttonLabel: string };

/** Checklist and version selection plus the start button, shared by the list and the card. */
export function RunEvaluation({ conversationIds, channels, buttonLabel }: Props) {
  const { track } = useJobs();
  const checklists = useAsync(() => api.listChecklists(), []);
  const [checklistId, setChecklistId] = useState('');
  const [version, setVersion] = useState<number | ''>('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = checklists.data ?? [];
  const selected = items.find((item) => item.checklist_id === checklistId);
  const channelKey = channels.join('|');

  // A voice call defaults to the voice checklist, a chat to the chat one.
  useEffect(() => {
    if (!items.length) return;
    const match = items.find((item) => channels.some((channel) => item.channels.includes(channel)));
    setChecklistId((match ?? items[0]).checklist_id);
    setVersion('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checklists.data, channelKey]);

  const mismatched = selected ? channels.filter((channel) => !selected.channels.includes(channel)) : [];

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const job = await api.createEvaluation({
        conversation_ids: conversationIds,
        checklist_id: checklistId,
        ...(version ? { version } : {}),
        ...(force ? { force } : {}),
      });
      track(job, `Оценка: ${selected?.title ?? checklistId}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось запустить оценку');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Чек-лист"
        className={`${inputClass} !w-56`}
        value={checklistId}
        onChange={(event) => {
          setChecklistId(event.target.value);
          setVersion('');
        }}
      >
        {checklists.loading && !items.length && <option>Загрузка…</option>}
        {checklists.error && <option>Чек-листы недоступны</option>}
        {items.map((item) => (
          <option key={item.checklist_id} value={item.checklist_id}>
            {item.title}
          </option>
        ))}
      </select>
      <select
        aria-label="Версия чек-листа"
        className={`${inputClass} !w-40`}
        value={version}
        onChange={(event) => setVersion(event.target.value ? Number(event.target.value) : '')}
      >
        <option value="">{selected ? `Последняя (v${selected.latest_version})` : 'Последняя'}</option>
        {selected &&
          Array.from({ length: selected.latest_version }, (_, index) => selected.latest_version - index).map((value) => (
            <option key={value} value={value}>
              v{value}
            </option>
          ))}
      </select>
      <label className="flex items-center gap-1 text-stone-600" title="Не брать результат из кэша">
        <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
        Заново
      </label>
      <Button variant="primary" disabled={busy || !conversationIds.length || !selected} onClick={start}>
        {busy ? 'Запуск…' : buttonLabel}
      </Button>
      {mismatched.length > 0 && (
        <span className="text-amber-800">Чек-лист не рассчитан на канал: {mismatched.map(channelLabel).join(', ')}</span>
      )}
      {error && <span role="alert" className="text-red-700">{error}</span>}
    </div>
  );
}
