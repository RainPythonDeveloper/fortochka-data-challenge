import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { ChecklistVersion, Criterion, CriterionType } from '../api/types';
import { Badge, Banner, Button, EmptyState, ErrorState, Field, LoadingState, inputClass } from '../components/ui';
import {
  normalizeChecklist,
  validateChecklist,
  validateNewChecklistId,
  type ValidationIssue,
} from '../lib/checklistValidation';
import { channelLabel, fmtNumber } from '../lib/format';
import { useAsync } from '../lib/useAsync';

const KNOWN_CHANNELS = ['agent chat', 'voice call'];

const blankChecklist = (taken: string[]): ChecklistVersion => ({
  checklist_id: nextId(taken, 'checklist-', 1),
  version: 1,
  title: '',
  channels: ['agent chat'],
  excluded_from_scoring: [],
  sections: [{ id: 's1', title: 'Основная секция' }],
  criteria: [],
});

function copyOf(source: ChecklistVersion, taken: string[]): ChecklistVersion {
  let id = `${source.checklist_id}-copy`;
  for (let number = 2; taken.includes(id); number += 1) id = `${source.checklist_id}-copy-${number}`;
  return { ...structuredClone(source), checklist_id: id, version: 1, title: `${source.title} (копия)` };
}

function nextId(taken: string[], prefix: string, width: number): string {
  let number = taken.length + 1;
  const make = () => `${prefix}${String(number).padStart(width, '0')}`;
  while (taken.includes(make())) number += 1;
  return make();
}

function CriterionEditor({
  criterion,
  sections,
  issues,
  onChange,
  onDelete,
}: {
  criterion: Criterion;
  sections: ChecklistVersion['sections'];
  issues: ValidationIssue[];
  onChange: (patch: Partial<Criterion>) => void;
  onDelete: () => void;
}) {
  const setType = (type: CriterionType) =>
    onChange(
      type === 'scale'
        ? { type, levels: criterion.levels.length ? criterion.levels : [{ value: 10, text: '' }, { value: 0, text: '' }] }
        : { type, levels: [] },
    );

  const setLevel = (position: number, patch: Partial<Criterion['levels'][number]>) =>
    onChange({ levels: criterion.levels.map((level, index) => (index === position ? { ...level, ...patch } : level)) });

  return (
    <div className="space-y-2 border-t border-line bg-stone-50 p-3">
      <div className="grid grid-cols-[1fr_180px] gap-2">
        <Field label="Формулировка">
          <input
            aria-label={`Формулировка ${criterion.id}`}
            className={inputClass}
            value={criterion.title}
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </Field>
        <Field label="Секция">
          <select className={inputClass} value={criterion.section} onChange={(event) => onChange({ section: event.target.value })}>
            {sections.map((section) => (
              <option key={section.id} value={section.id}>{section.title || section.id}</option>
            ))}
          </select>
        </Field>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <Field label="Тип ответа">
          <select
            aria-label={`Тип ответа ${criterion.id}`}
            className={`${inputClass} !w-32`}
            value={criterion.type}
            onChange={(event) => setType(event.target.value as CriterionType)}
          >
            <option value="boolean">Да/Нет</option>
            <option value="scale">Шкала</option>
          </select>
        </Field>
        <Field label="Вес">
          <input
            aria-label={`Вес ${criterion.id}`}
            type="number"
            min={0}
            step="any"
            disabled={!criterion.scored}
            className={`${inputClass} !w-20`}
            value={Number.isNaN(criterion.weight) ? '' : criterion.weight}
            onChange={(event) => onChange({ weight: event.target.valueAsNumber })}
          />
        </Field>
        <label className="flex items-center gap-1 pb-1">
          <input
            type="checkbox"
            checked={criterion.scored}
            onChange={(event) => onChange({ scored: event.target.checked, weight: event.target.checked ? criterion.weight : 0 })}
          />
          Влияет на баллы
        </label>
        <label className="flex items-center gap-1 pb-1">
          <input
            type="checkbox"
            checked={Boolean(criterion.flag)}
            onChange={(event) => onChange({ flag: event.target.checked ? 'gross_error' : null })}
          />
          Флаг грубой ошибки при «Да»
        </label>
        <label className="flex items-center gap-1 pb-1">
          <input
            aria-label={`N/A ${criterion.id}`}
            type="checkbox"
            checked={criterion.allow_na}
            onChange={(event) => onChange({ allow_na: event.target.checked, na_when: event.target.checked ? criterion.na_when : null })}
          />
          Доступен N/A
        </label>
      </div>

      {criterion.type === 'boolean' ? (
        <Field label="Условие «Да»">
          <textarea rows={2} className={inputClass} value={criterion.yes_when ?? ''} onChange={(event) => onChange({ yes_when: event.target.value })} />
        </Field>
      ) : (
        <>
          <Field label="Инструкция к шкале">
            <textarea rows={2} className={inputClass} value={criterion.prompt ?? ''} onChange={(event) => onChange({ prompt: event.target.value })} />
          </Field>
          <div>
            <p className="mb-1 text-xs font-medium text-stone-600">Ступени шкалы</p>
            <div className="space-y-1">
              {criterion.levels.map((level, position) => (
                <div key={position} className="flex gap-2">
                  <input
                    aria-label="Значение ступени"
                    type="number"
                    step={1}
                    className={`${inputClass} !w-20`}
                    value={Number.isNaN(level.value) ? '' : level.value}
                    onChange={(event) => setLevel(position, { value: event.target.valueAsNumber })}
                  />
                  <input
                    aria-label="Описание ступени"
                    className={inputClass}
                    value={level.text}
                    onChange={(event) => setLevel(position, { text: event.target.value })}
                  />
                  <Button
                    variant="danger"
                    aria-label="Удалить ступень"
                    onClick={() => onChange({ levels: criterion.levels.filter((_, index) => index !== position) })}
                  >
                    ×
                  </Button>
                </div>
              ))}
            </div>
            <Button variant="ghost" className="mt-1" onClick={() => onChange({ levels: [...criterion.levels, { value: 0, text: '' }] })}>
              + Ступень
            </Button>
          </div>
        </>
      )}

      {criterion.allow_na && (
        <Field label="Условие N/A">
          <textarea
            aria-label={`Условие N/A ${criterion.id}`}
            rows={2}
            className={inputClass}
            value={criterion.na_when ?? ''}
            onChange={(event) => onChange({ na_when: event.target.value })}
          />
        </Field>
      )}

      {issues.map((issue) => (
        <p key={issue.message} className="text-red-700">{issue.message}</p>
      ))}
      <div className="flex justify-end">
        <Button variant="danger" onClick={onDelete}>Удалить критерий</Button>
      </div>
    </div>
  );
}

type EditorProps = {
  base: ChecklistVersion;
  /** Null for a checklist that does not exist yet: saving then creates it as v1. */
  latestVersion: number | null;
  takenIds: string[];
  onSaved: (saved: ChecklistVersion) => void;
  onCancel?: () => void;
};

function Editor({ base, latestVersion, takenIds, onSaved, onCancel }: EditorProps) {
  const isNew = latestVersion === null;
  const [draft, setDraft] = useState(base);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issues = useMemo(
    () => [...(isNew ? validateNewChecklistId(draft.checklist_id, takenIds) : []), ...validateChecklist(draft)],
    [draft, isNew, takenIds],
  );
  const dirty = isNew || JSON.stringify(normalizeChecklist(draft)) !== JSON.stringify(normalizeChecklist(base));
  const weightSum = draft.criteria.reduce((sum, item) => sum + (item.scored && Number.isFinite(item.weight) ? item.weight : 0), 0);
  const channels = [...new Set([...KNOWN_CHANNELS, ...draft.channels])];

  const patchCriterion = (id: string, patch: Partial<Criterion>) =>
    setDraft((current) => ({
      ...current,
      criteria: current.criteria.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const addCriterion = (sectionId: string) => {
    const id = nextId(draft.criteria.map((item) => item.id), 'c', 2);
    const criterion: Criterion = {
      id, section: sectionId, title: '', type: 'boolean', weight: 0, scored: true, flag: null,
      allow_na: false, yes_when: '', prompt: null, na_when: null, levels: [], team_notes: [],
    };
    setDraft((current) => ({ ...current, criteria: [...current.criteria, criterion] }));
    setExpanded((current) => new Set(current).add(id));
  };

  const addSection = () => {
    const id = nextId(draft.sections.map((item) => item.id), 's', 1);
    setDraft((current) => ({ ...current, sections: [...current.sections, { id, title: '' }] }));
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = normalizeChecklist(draft);
      onSaved(await (isNew ? api.createChecklist(body) : api.createChecklistVersion(body)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Версия не сохранена');
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="sticky top-0 z-10 flex items-center gap-3 rounded border border-line bg-white px-3 py-2">
        <span className="text-stone-600">
          {isNew
            ? 'Новый чек-лист. Сохранение создаст версию v1.'
            : `Основа: v${base.version}. Сохранение создаст v${latestVersion + 1}, прежние версии не меняются.`}
        </span>
        <span className={`tabular-nums ${weightSum === 100 ? 'text-stone-500' : 'text-amber-800'}`}>
          Сумма весов: {fmtNumber(weightSum)}
        </span>
        <span className="ml-auto text-stone-500">{dirty ? 'Есть несохранённые изменения' : 'Изменений нет'}</span>
        {onCancel && <Button onClick={onCancel}>Отмена</Button>}
        <Button variant="primary" disabled={busy || !dirty || issues.length > 0} onClick={save}>
          {busy ? 'Сохранение…' : isNew ? 'Создать чек-лист' : 'Сохранить новую версию'}
        </Button>
      </div>

      {error && <p role="alert" className="rounded bg-red-50 p-2 text-red-800">{error}</p>}
      {issues.length > 0 && (
        <Banner tone="warn" title={`Нужно исправить перед сохранением: ${issues.length}`}>
          <ul className="list-inside list-disc">
            {issues.map((issue) => (
              <li key={issue.message}>{issue.message}</li>
            ))}
          </ul>
        </Banner>
      )}

      <section className="space-y-2 rounded border border-line bg-white p-3">
        {isNew && (
          <Field label="Идентификатор чек-листа">
            <input
              aria-label="Идентификатор чек-листа"
              className={inputClass}
              value={draft.checklist_id}
              onChange={(event) => setDraft({ ...draft, checklist_id: event.target.value.trim() })}
            />
          </Field>
        )}
        <Field label="Название чек-листа">
          <input aria-label="Название чек-листа" className={inputClass} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        </Field>
        <div className="flex items-center gap-4">
          <span className="text-xs font-medium text-stone-600">Каналы</span>
          {channels.map((channel) => (
            <label key={channel} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={draft.channels.includes(channel)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    channels: event.target.checked ? [...draft.channels, channel] : draft.channels.filter((item) => item !== channel),
                  })
                }
              />
              {channelLabel(channel)}
            </label>
          ))}
          <input
            aria-label="Другой канал"
            placeholder="Другой канал, Enter"
            className={`${inputClass} !w-44`}
            onKeyDown={(event) => {
              const value = event.currentTarget.value.trim();
              if (event.key !== 'Enter' || !value) return;
              event.preventDefault();
              if (!draft.channels.includes(value)) setDraft({ ...draft, channels: [...draft.channels, value] });
              event.currentTarget.value = '';
            }}
          />
        </div>
        {draft.excluded_from_scoring.length > 0 && (
          <p className="text-xs text-stone-500">Вне оценки: {draft.excluded_from_scoring.join(', ')}</p>
        )}
      </section>

      {draft.sections.map((section) => {
        const criteria = draft.criteria.filter((item) => item.section === section.id);
        return (
          <section key={section.id} className="overflow-hidden rounded border border-line bg-white">
            <div className="flex items-center gap-2 border-b border-line bg-stone-50 px-3 py-1.5">
              <input
                aria-label={`Название секции ${section.id}`}
                placeholder="Название секции"
                className={`${inputClass} font-medium`}
                value={section.title}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    sections: draft.sections.map((item) => (item.id === section.id ? { ...item, title: event.target.value } : item)),
                  })
                }
              />
              <Button variant="ghost" onClick={() => addCriterion(section.id)}>+ Критерий</Button>
              <Button
                variant="danger"
                disabled={criteria.length > 0}
                title={criteria.length ? 'Сначала перенесите или удалите критерии секции' : undefined}
                onClick={() => setDraft({ ...draft, sections: draft.sections.filter((item) => item.id !== section.id) })}
              >
                Удалить секцию
              </Button>
            </div>
            {!criteria.length && <p className="px-3 py-2 text-stone-500">В секции нет критериев.</p>}
            {criteria.map((criterion) => {
              const own = issues.filter((issue) => issue.criterionId === criterion.id);
              const open = expanded.has(criterion.id);
              return (
                <div key={criterion.id} className="border-b border-stone-100 last:border-0">
                  <button
                    type="button"
                    aria-expanded={open}
                    data-criterion-row={criterion.id}
                    onClick={() => toggle(criterion.id)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-brand-50/60"
                  >
                    <span className="w-8 text-xs text-stone-400">{criterion.id}</span>
                    <span className="min-w-0 flex-1 truncate font-medium">{criterion.title || 'Новый критерий'}</span>
                    {own.length > 0 && <Badge tone="bad">Ошибки: {own.length}</Badge>}
                    {criterion.flag && <Badge tone="bad">Флаг</Badge>}
                    {criterion.allow_na && <Badge tone="muted">N/A</Badge>}
                    <Badge>{criterion.type === 'scale' ? 'Шкала' : 'Да/Нет'}</Badge>
                    <span className="w-20 whitespace-nowrap text-right tabular-nums text-stone-600">
                      {criterion.scored ? `вес ${fmtNumber(criterion.weight)}` : 'без баллов'}
                    </span>
                  </button>
                  {open && (
                    <CriterionEditor
                      criterion={criterion}
                      sections={draft.sections}
                      issues={own}
                      onChange={(patch) => patchCriterion(criterion.id, patch)}
                      onDelete={() =>
                        setDraft({ ...draft, criteria: draft.criteria.filter((item) => item.id !== criterion.id) })
                      }
                    />
                  )}
                </div>
              );
            })}
          </section>
        );
      })}

      <Button onClick={addSection}>+ Секция</Button>
    </div>
  );
}

export function ChecklistsPage() {
  const list = useAsync(() => api.listChecklists(), []);
  const [selected, setSelected] = useState<{ id: string; version: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftNew, setDraftNew] = useState<{ base: ChecklistVersion; nonce: number } | null>(null);

  useEffect(() => {
    const first = list.data?.[0];
    if (!selected && first) setSelected({ id: first.checklist_id, version: first.latest_version });
  }, [list.data, selected]);

  const version = useAsync(
    () => (selected ? api.getChecklist(selected.id, selected.version) : Promise.resolve(null)),
    [selected?.id, selected?.version],
  );
  const summary = list.data?.find((item) => item.checklist_id === selected?.id);
  const takenIds = useMemo(() => (list.data ?? []).map((item) => item.checklist_id), [list.data]);

  const startNew = (base: ChecklistVersion) => {
    setNotice(null);
    setDraftNew((current) => ({ base, nonce: (current?.nonce ?? 0) + 1 }));
  };

  const onSaved = (saved: ChecklistVersion) => {
    setNotice(`Сохранена версия v${saved.version}. Её можно выбрать при запуске оценки.`);
    setDraftNew(null);
    setSelected({ id: saved.checklist_id, version: saved.version });
    list.reload();
  };

  return (
    <div className="mx-auto grid h-full max-w-[1400px] grid-cols-[260px_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-y-auto border-r border-line bg-white p-3">
        <h1 className="mb-2 text-base font-semibold">Чек-листы</h1>
        <div className="mb-3 flex gap-1">
          <Button disabled={!list.data} onClick={() => startNew(blankChecklist(takenIds))}>Новый</Button>
          <Button
            disabled={!version.data}
            title="Новый чек-лист на основе открытой версии"
            onClick={() => version.data && startNew(copyOf(version.data, takenIds))}
          >
            Копия открытого
          </Button>
        </div>
        {list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : !list.data ? (
          <LoadingState />
        ) : !list.data.length ? (
          <EmptyState title="Чек-листов нет" />
        ) : (
          <ul className="space-y-3">
            {list.data.map((item) => (
              <li key={item.checklist_id}>
                <p className="font-medium">{item.title}</p>
                <p className="text-xs text-stone-500">{item.channels.map(channelLabel).join(', ') || 'Каналы не заданы'}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {Array.from({ length: item.latest_version }, (_, index) => item.latest_version - index).map((value) => (
                    <Button
                      key={value}
                      className="!h-6"
                      variant={!draftNew && selected?.id === item.checklist_id && selected.version === value ? 'primary' : 'secondary'}
                      onClick={() => {
                        setNotice(null);
                        setDraftNew(null);
                        setSelected({ id: item.checklist_id, version: value });
                      }}
                    >
                      v{value}
                    </Button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <div className="min-h-0 overflow-y-auto p-3">
        {notice && <p role="status" className="mb-2 rounded bg-brand-50 px-2 py-1 text-brand-800">{notice}</p>}
        {draftNew ? (
          <Editor
            key={`new:${draftNew.nonce}`}
            base={draftNew.base}
            latestVersion={null}
            takenIds={takenIds}
            onSaved={onSaved}
            onCancel={() => setDraftNew(null)}
          />
        ) : version.error ? (
          <ErrorState message={version.error} onRetry={version.reload} />
        ) : !version.data || version.loading || !summary ? (
          list.error ? null : <LoadingState label="Загружаем чек-лист…" />
        ) : (
          <Editor
            key={`${version.data.checklist_id}:${version.data.version}`}
            base={version.data}
            latestVersion={summary.latest_version}
            takenIds={takenIds}
            onSaved={onSaved}
          />
        )}
      </div>
    </div>
  );
}
