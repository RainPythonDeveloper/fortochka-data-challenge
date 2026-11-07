import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { ConversationSummary, ImportResult, TranscriptResult } from '../api/types';
import { RunEvaluation } from '../components/RunEvaluation';
import { Badge, Button, EmptyState, ErrorState, Field, LoadingState, Modal, inputClass } from '../components/ui';
import { host } from '../host/hostAdapter';
import { channelLabel, fmtNumber, splitImportMessages } from '../lib/format';
import { useJobs } from '../lib/jobs';
import { useAsync } from '../lib/useAsync';

function TotalCell({ item }: { item: ConversationSummary }) {
  if (!item.latest_evaluation_id) return <span className="text-stone-400">Не оценён</span>;
  if (item.latest_total === null) return <Badge tone="warn">Итога нет</Badge>;
  return <span className="font-semibold tabular-nums">{fmtNumber(item.latest_total)}</span>;
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [groupId, setGroupId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const messages = result ? splitImportMessages(result.errors) : null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.importGroup(groupId.trim()));
      onDone();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Импорт не удался');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Импорт диалогов" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field label="group_id" hint="Значение группы выдают организаторы">
          <input autoFocus className={inputClass} value={groupId} onChange={(event) => setGroupId(event.target.value)} />
        </Field>
        {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
        {result && (
          <div className="mt-2 rounded bg-brand-50 p-2">
            <p>
              Группа {result.group_id}: загружено {result.imported}, пропущено {result.skipped}.
            </p>
          </div>
        )}
        {messages && messages.errors.length > 0 && (
          <div data-testid="import-errors" className="mt-2 rounded bg-red-50 p-2 text-red-800">
            <p className="font-medium">Ошибки: {messages.errors.length}</p>
            <ul className="max-h-32 overflow-y-auto">
              {messages.errors.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        )}
        {messages && messages.warnings.length > 0 && (
          <div data-testid="import-warnings" className="mt-2 rounded bg-amber-50 p-2 text-amber-900">
            <p className="font-medium">Предупреждения: {messages.warnings.length}</p>
            <ul className="max-h-32 overflow-y-auto">
              {messages.warnings.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <Button onClick={onClose}>{result ? 'Закрыть' : 'Отмена'}</Button>
          <Button variant="primary" type="submit" disabled={busy || !groupId.trim()}>
            {busy ? 'Импорт…' : 'Импортировать'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function TranscriptDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TranscriptResult | null>(null);

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) setText(await file.text());
  };

  const submit = async () => {
    setError(null);
    setResult(null);
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      setError('Текст не является корректным JSON.');
      return;
    }
    setBusy(true);
    try {
      setResult(await api.uploadTranscript(record));
      onDone();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Загрузка не удалась');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Загрузка транскрипта" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Файл JSON">
          <input aria-label="Файл транскрипта" type="file" accept=".json,application/json" onChange={readFile} />
        </Field>
        <Field label="Или вставьте JSON одной записи" hint="Поля записи: conversation_id, channel, language, transcript (timestamp, speaker, text)">
          <textarea
            aria-label="JSON транскрипта"
            rows={9}
            spellCheck={false}
            className={`${inputClass} font-mono text-xs`}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        {error && <p role="alert" className="rounded bg-red-50 p-2 text-red-800">{error}</p>}
        {result && (
          <div data-testid="upload-result" className="rounded bg-brand-50 p-2">
            <p>Загружен диалог {result.id}, реплик: {result.turn_count}.</p>
            {result.warnings.length > 0 && (
              <ul data-testid="upload-warnings" className="mt-1 text-amber-800">
                {result.warnings.map((item) => <li key={item}>{item}</li>)}
              </ul>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{result ? 'Закрыть' : 'Отмена'}</Button>
          {result ? (
            <Button variant="primary" onClick={() => navigate(`/conversations/${encodeURIComponent(result.id)}`)}>
              Открыть карточку
            </Button>
          ) : (
            <Button variant="primary" disabled={busy || !text.trim()} onClick={submit}>
              {busy ? 'Загрузка…' : 'Загрузить'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ExportControls() {
  const [groupId, setGroupId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async (format: 'json' | 'csv') => {
    const filters = { group_id: groupId.trim() || undefined };
    setBusy(true);
    setError(null);
    try {
      if (format === 'json') {
        host.saveFile('ai-results.json', JSON.stringify(await api.exportResults(filters), null, 2), 'application/json');
      } else {
        // The BOM lets Excel read Cyrillic correctly.
        host.saveFile('ai-results.csv', `\uFEFF${await api.exportCsv(filters)}`, 'text/csv;charset=utf-8');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Экспорт не удался');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1" title="Исходные автоматические результаты, без решений по апелляциям">
      {error && <span role="alert" className="mr-2 text-red-700">{error}</span>}
      <span className="text-stone-600">Экспорт:</span>
      <input
        aria-label="group_id для экспорта"
        placeholder="group_id"
        className={`${inputClass} !w-24`}
        value={groupId}
        onChange={(event) => setGroupId(event.target.value)}
      />
      <Button disabled={busy} onClick={() => download('json')}>JSON</Button>
      <Button disabled={busy} onClick={() => download('csv')}>CSV</Button>
    </div>
  );
}

export function ConversationsPage() {
  const { revision } = useJobs();
  const [channel, setChannel] = useState('');
  const [language, setLanguage] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const conversations = useAsync(
    () => api.listConversations({ channel: channel || undefined, language: language || undefined }),
    [channel, language, revision],
  );

  // Filter options come from the data: control sets may bring new channels or languages.
  const known = useRef({ channels: new Set<string>(), languages: new Set<string>() });
  useEffect(() => {
    for (const item of conversations.data ?? []) {
      known.current.channels.add(item.channel);
      known.current.languages.add(item.language);
    }
  }, [conversations.data]);

  const items = useMemo(() => conversations.data ?? [], [conversations.data]);
  const selectedItems = items.filter((item) => selected.has(item.id));
  const allSelected = items.length > 0 && selectedItems.length === items.length;
  const channels = [...new Set(selectedItems.map((item) => item.channel))];
  const hasFilter = Boolean(channel || language);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="mx-auto max-w-[1400px] p-4">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-base font-semibold">Диалоги</h1>
        <select aria-label="Канал" className={`${inputClass} !w-36`} value={channel} onChange={(event) => setChannel(event.target.value)}>
          <option value="">Все каналы</option>
          {[...new Set([...known.current.channels, ...items.map((item) => item.channel)])].map((value) => (
            <option key={value} value={value}>{channelLabel(value)}</option>
          ))}
        </select>
        <select aria-label="Язык" className={`${inputClass} !w-32`} value={language} onChange={(event) => setLanguage(event.target.value)}>
          <option value="">Все языки</option>
          {[...new Set([...known.current.languages, ...items.map((item) => item.language)])].map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
        <div className="ml-auto"><ExportControls /></div>
        <Button onClick={() => setUploading(true)}>Загрузить транскрипт</Button>
        <Button onClick={() => setImporting(true)}>Импорт по group_id</Button>
      </div>

      <div className="mb-2 flex min-h-9 items-center gap-3 rounded border border-line bg-white px-3 py-1">
        <span className="text-stone-600">Выбрано: {selectedItems.length}</span>
        <RunEvaluation
          conversationIds={selectedItems.map((item) => item.id)}
          channels={channels}
          buttonLabel="Запустить оценку"
        />
      </div>

      <div className="overflow-hidden rounded border border-line bg-white">
        {conversations.error ? (
          <ErrorState message={conversations.error} onRetry={conversations.reload} />
        ) : conversations.loading && !conversations.data ? (
          <LoadingState label="Загружаем диалоги…" />
        ) : !items.length ? (
          <EmptyState title={hasFilter ? 'Под фильтры ничего не подходит' : 'Диалогов пока нет'}>
            {hasFilter ? 'Измените канал или язык.' : 'Загрузите их кнопкой импорта по group_id.'}
          </EmptyState>
        ) : (
          <table className="w-full">
            <thead className="border-b border-line bg-stone-50 text-left text-xs text-stone-600">
              <tr>
                <th className="w-9 px-3 py-1.5">
                  <input
                    type="checkbox"
                    aria-label="Выбрать все"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)))}
                  />
                </th>
                <th className="px-2 py-1.5 font-medium">Диалог</th>
                <th className="px-2 py-1.5 font-medium">Канал</th>
                <th className="px-2 py-1.5 font-medium">Язык</th>
                <th className="px-2 py-1.5 text-right font-medium">Реплик</th>
                <th className="px-2 py-1.5 font-medium">Группа</th>
                <th className="px-2 py-1.5 text-right font-medium">Итог</th>
                <th className="px-2 py-1.5 font-medium">Грубая ошибка</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-stone-100 last:border-0 hover:bg-brand-50/50">
                  <td className="px-3 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Выбрать ${item.id}`}
                      checked={selected.has(item.id)}
                      onChange={() => toggle(item.id)}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Link className="font-medium text-brand-700 hover:underline" to={`/conversations/${encodeURIComponent(item.id)}`}>
                      {item.id}
                    </Link>
                  </td>
                  <td className="px-2 py-1.5">{channelLabel(item.channel)}</td>
                  <td className="px-2 py-1.5">{item.language}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{item.turn_count}</td>
                  <td className="px-2 py-1.5 text-stone-500">{item.group_id ?? '—'}</td>
                  <td className="px-2 py-1.5 text-right"><TotalCell item={item} /></td>
                  <td className="px-2 py-1.5">{item.gross_error && <Badge tone="bad">Грубая ошибка</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {importing && (
        <ImportDialog onClose={() => setImporting(false)} onDone={conversations.reload} />
      )}
      {uploading && <TranscriptDialog onClose={() => setUploading(false)} onDone={conversations.reload} />}
    </div>
  );
}
