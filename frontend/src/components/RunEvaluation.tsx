import { useState } from 'react';
import { api } from '../api';
import type { EvaluationRequest } from '../api/types';
import { channelLabel } from '../lib/format';
import { useJobs } from '../lib/jobs';
import { useAsync } from '../lib/useAsync';
import { Button, inputClass } from './ui';

type Props = { conversationIds: string[]; channels: string[]; buttonLabel: string };
type Mode = 'auto' | 'single' | 'per_channel';

const modeLabel: Record<Mode, string> = {
  auto: 'По каналу диалога',
  single: 'Один чек-лист на все',
  per_channel: 'Свой для каждого канала',
};

/** How a run picks its checklist, plus the start button. Shared by the list and the card. */
export function RunEvaluation({ conversationIds, channels, buttonLabel }: Props) {
  const { track } = useJobs();
  const checklists = useAsync(() => api.listChecklists(), []);
  const [mode, setMode] = useState<Mode>('auto');
  const [checklistId, setChecklistId] = useState('');
  const [version, setVersion] = useState<number | ''>('');
  const [byChannel, setByChannel] = useState<Record<string, string>>({});
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = checklists.data ?? [];
  const selected = items.find((item) => item.checklist_id === checklistId);
  const mismatched = mode === 'single' && selected ? channels.filter((channel) => !selected.channels.includes(channel)) : [];

  const buildChoice = (): Pick<EvaluationRequest, 'checklist_id' | 'version' | 'checklists_by_channel'> => {
    if (mode === 'single') return { checklist_id: checklistId, ...(version ? { version } : {}) };
    if (mode === 'auto') return {};
    const assigned = Object.fromEntries(channels.filter((channel) => byChannel[channel]).map((channel) => [channel, byChannel[channel]]));
    return Object.keys(assigned).length ? { checklists_by_channel: assigned } : {};
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const job = await api.createEvaluation({
        conversation_ids: conversationIds,
        ...buildChoice(),
        ...(force ? { force } : {}),
      });
      track(job, `Оценка: ${mode === 'single' ? (selected?.title ?? checklistId) : 'чек-лист по каналу'}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось запустить оценку');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Выбор чек-листа"
        className={`${inputClass} !w-48`}
        value={mode}
        onChange={(event) => {
          setMode(event.target.value as Mode);
          setError(null);
        }}
      >
        {(Object.keys(modeLabel) as Mode[]).map((value) => (
          <option key={value} value={value}>{modeLabel[value]}</option>
        ))}
      </select>

      {mode === 'single' && (
        <>
          <select
            aria-label="Чек-лист"
            className={`${inputClass} !w-52`}
            value={checklistId}
            onChange={(event) => {
              setChecklistId(event.target.value);
              setVersion('');
            }}
          >
            <option value="">Выберите чек-лист</option>
            {items.map((item) => (
              <option key={item.checklist_id} value={item.checklist_id}>{item.title}</option>
            ))}
          </select>
          <select
            aria-label="Версия чек-листа"
            className={`${inputClass} !w-36`}
            disabled={!selected}
            value={version}
            onChange={(event) => setVersion(event.target.value ? Number(event.target.value) : '')}
          >
            <option value="">{selected ? `Последняя (v${selected.latest_version})` : 'Последняя'}</option>
            {selected &&
              Array.from({ length: selected.latest_version }, (_, index) => selected.latest_version - index).map((value) => (
                <option key={value} value={value}>v{value}</option>
              ))}
          </select>
        </>
      )}

      {mode === 'per_channel' &&
        (channels.length ? (
          channels.map((channel) => (
            <label key={channel} className="flex items-center gap-1">
              <span className="text-stone-600">{channelLabel(channel)}:</span>
              <select
                aria-label={`Чек-лист для канала ${channel}`}
                className={`${inputClass} !w-48`}
                value={byChannel[channel] ?? ''}
                onChange={(event) => setByChannel((current) => ({ ...current, [channel]: event.target.value }))}
              >
                <option value="">Автоматически</option>
                {items.map((item) => (
                  <option key={item.checklist_id} value={item.checklist_id}>{item.title}</option>
                ))}
              </select>
            </label>
          ))
        ) : (
          <span className="text-stone-500">Выберите диалоги, чтобы назначить чек-листы их каналам</span>
        ))}

      <label className="flex items-center gap-1 text-stone-600" title="Не брать результат из кэша">
        <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
        Заново
      </label>
      <Button variant="primary" disabled={busy || !conversationIds.length || (mode === 'single' && !selected)} onClick={start}>
        {busy ? 'Запуск…' : buttonLabel}
      </Button>
      {mismatched.length > 0 && (
        <span className="text-amber-800">Чек-лист не рассчитан на канал: {mismatched.map(channelLabel).join(', ')}</span>
      )}
      {checklists.error && <span className="text-amber-800">Список чек-листов недоступен</span>}
      {error && <span role="alert" className="text-red-700">{error}</span>}
    </div>
  );
}
