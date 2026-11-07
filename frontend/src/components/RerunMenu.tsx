import { useState } from 'react';
import { api } from '../api';
import type { ChecklistSummary, EvaluationRequest } from '../api/types';
import { channelsLabel, errorText } from '../lib/format';
import { useJobs } from '../lib/jobs';
import { useAsync } from '../lib/useAsync';
import { Button, Menu } from './ui';

const AUTO = 'auto';

function versions(item: ChecklistSummary) {
  return Array.from({ length: item.latest_version }, (_, index) => item.latest_version - index);
}

function Form({ conversationId, channel, close }: { conversationId: string; channel: string; close: () => void }) {
  const { track } = useJobs();
  const lists = useAsync(() => api.listChecklists(), []);
  const [choice, setChoice] = useState(AUTO);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byChannel = lists.data?.find((item) => item.channels.includes(channel));

  const start = async () => {
    setBusy(true);
    setError(null);
    const [id, version] = choice.split('\n');
    const target: Partial<EvaluationRequest> = choice === AUTO ? {} : { checklist_id: id, version: Number(version) };
    try {
      const job = await api.createEvaluation({ conversation_ids: [conversationId], ...target, ...(force ? { force } : {}) });
      track(job, [conversationId]);
      close();
    } catch (reason) {
      setError(errorText(reason, 'Не удалось запустить оценку'));
      setBusy(false);
    }
  };

  const option = (value: string, label: string) => (
    <label key={value} className="rerun__option">
      <input type="radio" name="rerun-sheet" checked={choice === value} onChange={() => setChoice(value)} />
      {label}
    </label>
  );

  return (
    <>
      <div className="rerun__list">
        {option(AUTO, byChannel ? `По каналу: ${channelsLabel(channel)}, версия ${byChannel.latest_version}` : 'По каналу')}
        {lists.data?.flatMap((item) =>
          versions(item).map((version) => option(`${item.checklist_id}\n${version}`, `${item.title}, версия ${version}`)),
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
        Не брать из кэша
      </label>
      {error && <p role="alert" className="notice mb-2 px-2" data-tone="bad">{error}</p>}
      <Button variant="primary" className="w-full" disabled={busy} onClick={start}>Оценить</Button>
    </>
  );
}

export function RerunMenu({ conversationId, channel, label = 'Оценить заново' }: { conversationId: string; channel: string; label?: string }) {
  return (
    <Menu
      popClass="rerun"
      trigger={({ open, toggle }) => (
        <Button variant="text" aria-expanded={open} onClick={toggle}>{label}</Button>
      )}
    >
      {(close) => <Form conversationId={conversationId} channel={channel} close={close} />}
    </Menu>
  );
}
